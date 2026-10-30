"""Idempotent file transfer into the existing organic publisher's native draft queues."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime, timedelta

import httpx

from .media_registry import MediaRegistry
from .organic_bridge import ORIGIN


class PublisherHandoff:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_media_handoff (job TEXT PRIMARY KEY, state TEXT NOT NULL, next_attempt REAL NOT NULL, payload TEXT NOT NULL)')

    def records(self):
        with closing(self.audit._connect()) as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM pilot_media_handoff ORDER BY job')]

    def save(self, job, record, next_attempt):
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_media_handoff VALUES (?,?,?,?) ON CONFLICT(job) DO UPDATE SET state=excluded.state,next_attempt=excluded.next_attempt,payload=excluded.payload',
                       (job, record['state'], next_attempt, json.dumps(record)))

    @staticmethod
    def verify_receipt(body, asset):
        if body.get('job_id') != asset['job_id'] or body.get('sha256') != asset['sha256']:
            raise ValueError('PUBLISHER_RECEIPT_IDENTITY_MISMATCH')
        if not re.fullmatch(r'gid://shopify/Product/\d+', body.get('product_id', '')):
            raise ValueError('PUBLISHER_RECEIPT_PRODUCT_INVALID')
        posts = body.get('posts')
        if not isinstance(posts, list) or not 1 <= len(posts) <= 4:
            raise ValueError('PUBLISHER_QUEUE_ROWS_MISSING')
        channels, ids = set(), set()
        for post in posts:
            if (post.get('channel') not in {'facebook', 'instagram', 'pinterest', 'tiktok'}
                    or not re.fullmatch(r'[a-f0-9-]{36}', post.get('id', ''))
                    or post['id'] in ids or post['channel'] in channels
                    or post.get('status') not in {'draft_queued', 'approved', 'publishing', 'remote_pending',
                        'published', 'recovery_required', 'rejected', 'superseded'}):
                raise ValueError('PUBLISHER_QUEUE_ROW_INVALID')
            ids.add(post['id'])
            channels.add(post['channel'])
        # Queue receipt remains separate from actual platform publication evidence.
        return {'job_id': asset['job_id'], 'sha256': asset['sha256'], 'state': 'publisher_queue_confirmed',
                'product_id': body['product_id'], 'posts': posts,
                'requires_visual_review': body.get('requires_visual_review', True),
                'publication_confirmed': (body.get('publication_confirmed') is True) and
                    any(post.get('status') == 'published' and post.get('permalink') for post in posts),
                'generation_performed': False}

    async def cycle(self, *, env=None, client=None, now=None):
        env = os.environ if env is None else env
        key = env.get('PILOT_ORGANIC_API_KEY', '')
        if not key or key.startswith('${{'):
            return {'status': 'not_configured', 'reason': 'EXISTING_PUBLISHER_INTERNAL_CREDENTIAL_REFERENCE_REQUIRED',
                    'publication_confirmed': False}
        now = now or datetime.now(UTC)
        registry = MediaRegistry(self.audit)
        assets = [row for row in registry.list() if row['file_available'] and row['matched_product_ids']]
        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(40, connect=5), follow_redirects=False)
        headers = {'Authorization': 'Bearer ' + key}
        async def request(method, path, **kwargs):
            async with client.stream(method, ORIGIN + '/api/marketing/v2/' + path,
                                     headers={**headers, **kwargs.pop('headers', {})}, follow_redirects=False, **kwargs) as response:
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > 256 * 1024:
                        raise ValueError('PUBLISHER_RECEIPT_SIZE_LIMIT')
                httpx.Response(response.status_code, content=bytes(body), request=response.request).raise_for_status()
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError('PUBLISHER_RECEIPT_NOT_OBJECT')
            return result
        results = []
        try:
            for asset in assets:
                job = asset['job_id']
                with closing(self.audit._connect()) as db:
                    stored = db.execute('SELECT next_attempt FROM pilot_media_handoff WHERE job=?', (job,)).fetchone()
                # Poll already queued drafts on every cycle; only failed handoffs
                # need backoff. Never re-import an existing media job.
                if stored and stored[0] > now.timestamp():
                    with closing(self.audit._connect()) as db:
                        prior = db.execute('SELECT payload FROM pilot_media_handoff WHERE job=?', (job,)).fetchone()
                    if prior:
                        previous = json.loads(prior[0])
                        if previous.get('state') != 'publisher_queue_confirmed':
                            continue
                delay = timedelta(minutes=5)
                try:
                    current = await request('GET', 'media/imports/' + job)
                    if current.get('state') != 'queued':
                        source = registry.root / (asset['sha256'] + ('.image' if asset['kind'] == 'image' else '.mp4'))
                        data = await asyncio.to_thread(source.read_bytes)
                        if hashlib.sha256(data).hexdigest() != asset['sha256']:
                            raise ValueError('LOCAL_MEDIA_CHECKSUM_MISMATCH')
                        metadata = {'provider': 'higgsfield', 'job_id': job, 'kind': asset['kind'],
                                    'sha256': asset['sha256'], 'product_url': asset['source_product_url']}
                        await request('POST', 'media/import', headers={
                            'X-Pilot-Asset-Meta': base64.b64encode(json.dumps(metadata).encode()).decode(),
                            'Content-Type': 'image/png' if asset['kind'] == 'image' else 'video/mp4'}, content=data)
                        current = await request('GET', 'media/imports/' + job)
                    result = self.verify_receipt(current, asset)
                except httpx.HTTPStatusError as exc:
                    result = {'job_id': job, 'state': 'publisher_handoff_blocked',
                              'http_status': exc.response.status_code, 'publication_confirmed': False}
                    try:
                        code = exc.response.json().get('error', '')
                        if re.fullmatch(r'[A-Z0-9_]{1,80}', code):
                            result['reason'] = code
                    except (ValueError, AttributeError):
                        pass
                    delay = timedelta(hours=6)
                    if exc.response.status_code in {401, 403}:
                        self.save(job, result, (now + delay).timestamp())
                        results.append(result)
                        break
                except (ValueError, KeyError, OSError, httpx.HTTPError) as exc:
                    result = {'job_id': job, 'state': 'publisher_handoff_unconfirmed',
                              'error_type': type(exc).__name__, 'publication_confirmed': False}
                # Existing confirmed queues are read-only polled; no duplicate imports.
                # Published receipts require platform IDs/permalinks from the publisher.
                if result.get('state') == 'publisher_queue_confirmed':
                    delay = timedelta(minutes=5)
                self.save(job, result, (now + delay).timestamp())
                results.append(result)
            rows = self.records()
            confirmed = [row for row in rows if row['state'] == 'publisher_queue_confirmed']
            return {'status': 'checked', 'available_mapped_assets': len(assets),
                'queue_confirmed_assets': len(confirmed),
                'queue_confirmed_rows': sum(len(row['posts']) for row in confirmed),
                'blocked_or_unconfirmed_assets': len(rows) - len(confirmed), 'results': results,
                'publication_confirmed_assets': sum(bool(row['publication_confirmed']) for row in confirmed),
                'generation_performed': False}
        finally:
            if own:
                await client.aclose()
