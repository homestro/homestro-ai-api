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


async def read_catalog_brain(*, env=None, client=None):
    """Observe the sole catalog coordinator using the existing internal credential."""
    import json
    import os

    env = os.environ if env is None else env
    key = env.get('PILOT_ORGANIC_API_KEY', '')
    if not key or key.startswith('${{'):
        return {'status': 'not_configured', 'reason': 'EXISTING_PUBLISHER_INTERNAL_CREDENTIAL_REFERENCE_REQUIRED'}
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4), follow_redirects=False)
    try:
        async with client.stream('GET', ORIGIN + '/api/marketing/v2/catalog-brain',
                headers={'Authorization': 'Bearer ' + key}, follow_redirects=False) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 1024 * 1024:
                    raise ValueError('CATALOG_BRAIN_REPORT_SIZE_LIMIT')
        body = json.loads(data)
        generated = datetime.fromisoformat(body['generatedAt'].replace('Z', '+00:00'))
        if generated.tzinfo is None or not -60 <= (datetime.now(UTC) - generated).total_seconds() <= 900:
            raise ValueError('STALE_CATALOG_BRAIN_REPORT')
        if type(body.get('enabled')) is not bool or not isinstance(body.get('counts'), list):
            raise ValueError('INVALID_CATALOG_BRAIN_REPORT')
        counts, seen = [], set()
        for row in body['counts']:
            if (row.get('state') not in {'due', 'blocked', 'processing', 'prepared', 'waiting'}
                or row['state'] in seen or type(row.get('count')) is not int or not 0 <= row['count'] <= 100000):
                raise ValueError('INVALID_CATALOG_BRAIN_COUNTS')
            seen.add(row['state'])
            counts.append({'state': row['state'], 'count': row['count']})
        return {'status': 'observed', 'enabled': body['enabled'], 'generated_at': body['generatedAt'],
            'catalog_records': sum(row['count'] for row in counts), 'counts': counts,
            'publication_auto_approval_enabled': body.get('publicationAutoApprovalEnabled') if type(body.get('publicationAutoApprovalEnabled')) is bool else None,
            'publication_confirmed': False, 'evidence_level': 'catalog_work_ledger_not_platform_publication',
            'paid_generation_authorized': False, 'writes_performed': False}
    except (ValueError, TypeError, KeyError, AttributeError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()
