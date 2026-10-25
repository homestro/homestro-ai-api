"""Import existing completed media with content hashes, format checks and durable review queue."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import tempfile
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from PIL import Image

from .marketing_director import canonical

HOSTS = {'d8j0ntlcm91z4.cloudfront.net'}
MAX_BYTES = 100 * 1024 * 1024


def approved_source(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.hostname in HOSTS and parsed.port in (None, 443)
                and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def probe(path, kind):
    if kind == 'image':
        with Image.open(path) as image:
            width, height = image.size
            if width * height > 40_000_000:
                raise ValueError('MEDIA_PIXEL_LIMIT')
            image.verify()
        return {'width': width, 'height': height, 'duration_seconds': None}
    result = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-show_streams',
                             '-of', 'json', str(path)], capture_output=True, timeout=10, check=True)
    streams = json.loads(result.stdout)['streams']
    videos = [item for item in streams if item.get('codec_type') == 'video']
    if len(videos) != 1:
        raise ValueError('ONE_VIDEO_STREAM_REQUIRED')
    item = videos[0]
    width, height = int(item['width']), int(item['height'])
    duration = float(item.get('duration', '0'))
    if not 0 < duration <= 180 or width * height > 40_000_000:
        raise ValueError('VIDEO_DURATION_OR_PIXEL_LIMIT')
    return {'width': width, 'height': height, 'duration_seconds': duration}


class MediaRegistry:
    def __init__(self, audit, *, root=None):
        self.audit = audit
        self.root = Path(root or audit.database_path.parent / 'imported-media')
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_imported_media (job TEXT PRIMARY KEY, checksum TEXT NOT NULL, payload TEXT NOT NULL)')

    def list(self):
        with closing(self.audit._connect()) as db:
            rows = [json.loads(row[0]) for row in db.execute('SELECT payload FROM pilot_imported_media ORDER BY job')]
        for row in rows:
            path = self.root / (row['sha256'] + ('.image' if row['kind'] == 'image' else '.mp4'))
            row['file_available'] = path.is_file() and path.stat().st_size == row['byte_count']
        return rows

    async def import_one(self, record, products, *, client):
        if record.get('provider') != 'higgsfield' or record.get('status', '').upper() != 'COMPLETED':
            raise ValueError('COMPLETED_EXISTING_HIGGSFIELD_OUTPUT_REQUIRED')
        job, kind, url = record.get('job_id', ''), record.get('kind'), record.get('url', '')
        if not re.fullmatch(r'[a-f0-9-]{36}', job) or kind not in {'image', 'video'} or not approved_source(url):
            raise ValueError('UNAPPROVED_MEDIA_SOURCE')
        with closing(self.audit._connect()) as db:
            existing = db.execute('SELECT payload FROM pilot_imported_media WHERE job=?', (job,)).fetchone()
        if existing:
            previous = json.loads(existing[0])
            path = self.root / (previous['sha256'] + ('.image' if kind == 'image' else '.mp4'))
            if path.is_file() and await asyncio.to_thread(lambda: hashlib.sha256(path.read_bytes()).hexdigest()) == previous['sha256']:
                target = record.get('product_url')
                if target:
                    if previous.get('source_product_url') and canonical(previous['source_product_url']) != canonical(target):
                        raise ValueError('EXISTING_JOB_PRODUCT_MAPPING_CHANGED')
                    matches = []
                    for product in products:
                        try:
                            if canonical(product.get('link', '')) == canonical(target):
                                matches.append(str(product['id']))
                        except ValueError:
                            continue
                    previous['source_product_url'] = target
                    previous['matched_product_ids'] = matches
                    previous['state'] = 'review_required' if matches else 'product_mapping_required'
                    previous['blockers'] = ['VISUAL_REVIEW_REQUIRED'] + ([] if matches else ['VERIFIED_PRODUCT_MAPPING_REQUIRED']) + ([] if previous['aspect_ratio'] in {'1:1', '9:16'} else ['UNSUPPORTED_PUBLICATION_ASPECT_RATIO'])
                    with closing(self.audit._connect()) as db, db:
                        db.execute('UPDATE pilot_imported_media SET payload=? WHERE job=?', (json.dumps(previous), job))
                return {**previous, 'already_imported': True}
        payload = bytearray()
        async with client.stream('GET', url, follow_redirects=False) as response:
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError('MEDIA_REDIRECT_REJECTED')
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > MAX_BYTES:
                    raise ValueError('MEDIA_SIZE_LIMIT')
        if not payload:
            raise ValueError('EMPTY_MEDIA')
        checksum = hashlib.sha256(payload).hexdigest()
        if existing and checksum != json.loads(existing[0])['sha256']:
            raise ValueError('SOURCE_CHANGED_FOR_EXISTING_JOB')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, suffix='.png' if kind == 'image' else '.mp4', delete=False) as output:
                temporary = Path(output.name)
                output.write(payload)
            facts = await asyncio.to_thread(probe, temporary, kind)
            width, height = facts['width'], facts['height']
            ratio = '1:1' if width == height else '9:16' if abs(width / height - 9 / 16) < 0.01 else 'other'
            product_url = record.get('product_url')
            matches = []
            if product_url:
                path = canonical(product_url)
                for product in products:
                    try:
                        if canonical(product.get('link', '')) == path:
                            matches.append(str(product['id']))
                    except ValueError:
                        continue
            row = {'job_id': job, 'provider': 'higgsfield', 'kind': kind, 'sha256': checksum,
                'byte_count': len(payload), **facts, 'aspect_ratio': ratio,
                'matched_product_ids': matches, 'source_product_url': product_url,
                'state': 'review_required' if matches else 'product_mapping_required',
                'publication_queue': 'media_review', 'publication_confirmed': False,
                'blockers': ['VISUAL_REVIEW_REQUIRED'] + ([] if matches else ['VERIFIED_PRODUCT_MAPPING_REQUIRED'])
                            + ([] if ratio in {'1:1', '9:16'} else ['UNSUPPORTED_PUBLICATION_ASPECT_RATIO']),
                'generation_performed': False, 'already_imported': False}
            destination = self.root / (checksum + ('.image' if kind == 'image' else '.mp4'))
            # Content-addressed storage reuses identical exports across different jobs.
            if destination.exists():
                if await asyncio.to_thread(lambda: hashlib.sha256(destination.read_bytes()).hexdigest()) != checksum:
                    raise ValueError('EXISTING_MEDIA_CHECKSUM_MISMATCH')
            else:
                os.replace(temporary, destination)
            with closing(self.audit._connect()) as db, db:
                db.execute('INSERT OR IGNORE INTO pilot_imported_media VALUES (?,?,?)',
                           (job, checksum, json.dumps(row)))
            return row
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    async def seed_existing(self, products, *, client=None, limit=3):
        from .existing_media import EXISTING_ASSETS

        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)
        imported = {item['job_id'] for item in self.list() if item['file_available']}
        results = []
        try:
            for record in [item for item in EXISTING_ASSETS if item['job_id'] in imported]:
                await self.import_one(record, products, client=client)
            for record in [item for item in EXISTING_ASSETS if item['job_id'] not in imported][:limit]:
                try:
                    async with asyncio.timeout(30):
                        results.append(await self.import_one(record, products, client=client))
                except (ValueError, OSError, TimeoutError, httpx.HTTPError, subprocess.SubprocessError) as exc:
                    results.append({'job_id': record['job_id'], 'state': 'import_unavailable', 'error_type': type(exc).__name__})
            rows = self.list()
            return {'existing_output_count': len(EXISTING_ASSETS), 'stored_count': len(rows),
                'stored_images': sum(row['kind'] == 'image' for row in rows),
                'stored_videos': sum(row['kind'] == 'video' for row in rows),
                'remaining_imports': len(EXISTING_ASSETS) - len(rows), 'results': results,
                'review_queue_count': len(rows), 'publication_confirmed': False, 'generation_performed': False}
        finally:
            if own:
                await client.aclose()
