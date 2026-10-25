"""Read existing organic publisher receipts without creating a second publisher."""
from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx

ORIGIN = 'https://homestro-ai-api-fixed-current-production.up.railway.app'


async def read_organic_results(*, client=None):
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4), follow_redirects=False)
    try:
        async with client.stream('GET', ORIGIN + '/api/marketing/v2/public-results?days=7') as response:
            response.raise_for_status()
            payload = bytearray()
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > 1024 * 1024:
                    raise ValueError('ORGANIC_REPORT_SIZE_LIMIT')
        import json
        body = json.loads(payload)
        if not isinstance(body, dict) or not isinstance(body.get('generatedAt'), str):
            raise ValueError('INVALID_ORGANIC_REPORT')
        total = body['publishedTotal']
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            raise ValueError('INVALID_ORGANIC_PUBLICATION_COUNT')
        generated = datetime.fromisoformat(body['generatedAt'].replace('Z', '+00:00'))
        age = (datetime.now(UTC) - generated).total_seconds()
        if not -60 <= age <= 900:
            raise ValueError('STALE_ORGANIC_REPORT')
        channels = []
        for row in body.get('channels', []):
            if not isinstance(row, dict):
                raise ValueError('INVALID_ORGANIC_CHANNEL')
            if row.get('channel') not in {'facebook', 'instagram', 'tiktok', 'pinterest'}:
                continue
            count = row.get('published')
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError('INVALID_ORGANIC_CHANNEL_COUNT')
            channels.append({'channel': row['channel'], 'published': count})
        guides = []
        for row in body.get('guides', [])[:10]:
            target = urlsplit(row.get('url') or '')
            if target.scheme == 'https' and target.hostname in {'homestro.de', 'www.homestro.de'} and not target.username:
                guides.append({'handle': str(row.get('handle', ''))[:160], 'url': row['url']})
        return {'status': 'observed', 'source': ORIGIN + '/api/marketing/v2/public-results?days=7',
                'generated_at': generated.isoformat(), 'published_records_7d': total, 'channels': channels,
                'published_guide_records': guides, 'evidence_level': 'existing_publisher_database_receipts',
                'platform_visibility_independently_verified': False, 'writes_performed': False}
    except (ValueError, TypeError, KeyError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()
