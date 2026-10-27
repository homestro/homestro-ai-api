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
        async def page(after=None):
            async with client.stream('GET', ORIGIN + '/api/marketing/v2/catalog-brain',
                    params={'after': after} if after else None,
                    headers={'Authorization': 'Bearer ' + key}, follow_redirects=False) as response:
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 1024 * 1024:
                        raise ValueError('CATALOG_BRAIN_REPORT_SIZE_LIMIT')
            value = json.loads(data)
            generated = datetime.fromisoformat(value['generatedAt'].replace('Z', '+00:00'))
            if generated.tzinfo is None or not -60 <= (datetime.now(UTC) - generated).total_seconds() <= 900:
                raise ValueError('STALE_CATALOG_BRAIN_REPORT')
            if type(value.get('enabled')) is not bool or not isinstance(value.get('counts'), list):
                raise ValueError('INVALID_CATALOG_BRAIN_REPORT')
            if not isinstance(value.get('products', []), list) or len(value.get('products', [])) > 100:
                raise ValueError('CATALOG_PRODUCT_PAGE_LIMIT')
            return value

        body = await page()
        source_rows, page_count, cursors = list(body.get('products', [])), 1, set()
        info = body.get('pageInfo')
        coverage_complete = False
        while info is not None:
            if not isinstance(info, dict) or type(info.get('hasNextPage')) is not bool:
                raise ValueError('INVALID_CATALOG_PAGINATION')
            if info['hasNextPage'] is False:
                coverage_complete = True
                break
            cursor = info.get('endCursor')
            if (not isinstance(cursor, str) or not 1 <= len(cursor) <= 256 or cursor in cursors
                or page_count >= 20):
                raise ValueError('CATALOG_PAGINATION_UNCONFIRMED_OR_LIMIT')
            cursors.add(cursor)
            following = await page(cursor)
            if following['enabled'] != body['enabled'] or following['counts'] != body['counts']:
                raise ValueError('CATALOG_CHANGED_DURING_PAGINATION')
            source_rows.extend(following.get('products', []))
            page_count += 1
            info = following.get('pageInfo')
            if info is None:
                raise ValueError('CATALOG_PAGINATION_DISAPPEARED')
        counts, seen = [], set()
        for row in body['counts']:
            if (row.get('state') not in {'due', 'blocked', 'processing', 'prepared', 'waiting'}
                or row['state'] in seen or type(row.get('count')) is not int or not 0 <= row['count'] <= 100000):
                raise ValueError('INVALID_CATALOG_BRAIN_COUNTS')
            seen.add(row['state'])
            counts.append({'state': row['state'], 'count': row['count']})
        if coverage_complete:
            source_ids = [row.get('product_id') for row in source_rows if isinstance(row, dict)]
            if (len(source_rows) != sum(row['count'] for row in counts) or len(source_ids) != len(source_rows)
                or any(not isinstance(key, str) for key in source_ids) or len(set(source_ids)) != len(source_ids)):
                raise ValueError('CATALOG_PAGINATION_COVERAGE_UNCONFIRMED')
        products, paths = [], set()
        if len(source_rows) > 2000:
            raise ValueError('CATALOG_PRODUCT_EVIDENCE_LIMIT')
        for row in source_rows:
            decision = row.get('decision') or {}
            product_id, revision = row.get('product_id'), decision.get('revision')
            target = urlsplit(decision.get('creativeBrief', {}).get('sourceProductURL') or '')
            if (not isinstance(product_id, str) or not product_id.startswith('gid://shopify/Product/')
                or product_id != decision.get('productId') or not isinstance(revision, str) or not 1 <= len(revision) <= 200
                or target.scheme != 'https' or target.hostname not in {'homestro.de', 'www.homestro.de'}
                or target.username or target.password or target.port not in (None, 443)
                or not target.path.startswith('/products/') or type(decision.get('eligible')) is not bool):
                continue
            if target.path in paths:
                raise ValueError('AMBIGUOUS_CATALOG_PRODUCT_EVIDENCE')
            paths.add(target.path)
            receipts = []
            current = row.get('currentReceipts', [])
            if not isinstance(current, list) or len(current) > 100:
                raise ValueError('INVALID_PRODUCT_RECEIPTS')
            for receipt in current:
                if (receipt.get('channel') not in {'facebook', 'instagram', 'pinterest', 'tiktok'}
                    or receipt.get('status') not in {'draft_queued', 'approved', 'publishing', 'remote_pending',
                        'published', 'recovery_required', 'rejected', 'superseded'}
                    or type(receipt.get('count')) is not int or not 0 <= receipt['count'] <= 100000):
                    raise ValueError('INVALID_PRODUCT_RECEIPTS')
                receipts.append({key: receipt[key] for key in ('channel', 'status', 'count')})
            products.append({'product_id': product_id, 'revision': revision, 'source_url': target.geturl(),
                'eligible': decision['eligible'], 'state': row.get('state'), 'receipts': receipts,
                'last_attempt_at': row.get('last_attempt_at'), 'publication_confirmed': False})
        return {'status': 'observed', 'enabled': body['enabled'], 'generated_at': body['generatedAt'],
            'catalog_records': sum(row['count'] for row in counts), 'counts': counts, 'products': products,
            'source_records_read': len(source_rows), 'pages_read': page_count, 'coverage_complete': coverage_complete,
            'publication_auto_approval_enabled': body.get('publicationAutoApprovalEnabled') if type(body.get('publicationAutoApprovalEnabled')) is bool else None,
            'publication_confirmed': False, 'evidence_level': 'catalog_work_ledger_not_platform_publication',
            'paid_generation_authorized': False, 'writes_performed': False}
    except (ValueError, TypeError, KeyError, AttributeError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()


async def read_operations(*, env=None, client=None, now=None):
    """Bounded authenticated read of actual scheduling/media counts, never a publisher."""
    import json
    import os

    env = os.environ if env is None else env
    key = env.get('PILOT_ORGANIC_API_KEY', '')
    if not key or key.startswith('${{'):
        return {'status': 'not_configured', 'reason': 'EXISTING_PUBLISHER_INTERNAL_CREDENTIAL_REFERENCE_REQUIRED'}
    now = now or datetime.now(UTC)
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4), follow_redirects=False)
    try:
        async with client.stream('GET', ORIGIN + '/api/marketing/v2/operations',
                headers={'Authorization': 'Bearer ' + key}, follow_redirects=False) as reply:
            reply.raise_for_status()
            data = bytearray()
            async for chunk in reply.aiter_bytes():
                data.extend(chunk)
                if len(data) > 4 * 1024 * 1024:
                    raise ValueError('OPERATIONS_RESPONSE_LIMIT')
        value = json.loads(data)
        generated = datetime.fromisoformat(value['generatedAt'].replace('Z', '+00:00'))
        if (value.get('brand') != 'Homestro' or generated.tzinfo is None
                or not -60 <= (now - generated).total_seconds() <= 900
                or value.get('generationPerformed') is not False
                or value.get('newPublicationConfirmed') is not False):
            raise ValueError('OPERATIONS_SOURCE_OR_FRESHNESS_INVALID')
        catalog = value['catalog']
        media = value['media']
        counts = {field: media[field] for field in ('sourceImages', 'nativeVideoProducts', 'importedImages', 'importedVideos')}
        counts['catalogRecords'] = catalog['records']
        if any(type(count) is not int or not 0 <= count <= 1000000 for count in counts.values()):
            raise ValueError('OPERATIONS_COUNTS_INVALID')
        receipts = value['receipts']
        if not isinstance(receipts, list) or len(receipts) > 20000:
            raise ValueError('OPERATIONS_RECEIPT_LIMIT')
        scheduled, uncertain, recorded = 0, 0, 0
        for row in receipts:
            if (not isinstance(row, dict) or row.get('channel') not in {'facebook', 'instagram', 'tiktok', 'pinterest'}
                    or row.get('mediaKind') not in {'image', 'video', 'missing'}):
                raise ValueError('OPERATIONS_RECEIPT_INVALID')
            if row.get('scheduledFor'):
                date = datetime.fromisoformat(row['scheduledFor'].replace('Z', '+00:00'))
                if date.tzinfo is None or row.get('status') != 'approved':
                    raise ValueError('OPERATIONS_SCHEDULE_INVALID')
                scheduled += 1
            uncertain += row.get('status') in {'recovery_required', 'remote_pending', 'publishing'}
            recorded += row.get('status') == 'published'
        health = value.get('openai') or {}
        return {'status': 'observed', 'generated_at': generated.isoformat(), 'counts': counts,
                'scheduled_receipts': scheduled, 'uncertain_receipts': uncertain,
                'recorded_published_receipts': recorded,
                'openai_status': health.get('status') if health.get('status') in {'not_configured', 'blocked', 'retry_due', 'unverified'} else 'unknown',
                'evidence_level': 'persisted_publisher_receipts_and_earliest_schedule_not_live_delivery',
                'publication_confirmed': False, 'writes_performed': False}
    except (ValueError, TypeError, KeyError, AttributeError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()
