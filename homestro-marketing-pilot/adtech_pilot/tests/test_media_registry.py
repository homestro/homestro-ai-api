import io
import tempfile
import unittest
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.media_registry import MAX_BYTES, MediaRegistry
from PIL import Image


class MediaRegistryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.registry = MediaRegistry(self.audit)
        self.record = {'provider': 'higgsfield', 'status': 'completed', 'kind': 'image',
            'job_id': 'e9ef0df6-9d35-4c40-ac10-051bd6f50667',
            'url': 'https://d8j0ntlcm91z4.cloudfront.net/existing.png',
            'product_url': 'https://homestro.de/products/box'}
        self.products = [{'id': '123', 'link': 'https://homestro.de/products/box?variant=123'}]
        image = Image.new('RGB', (32, 32), 'green')
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        self.body = buffer.getvalue()

    async def imported(self, response=None, record=None):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response or httpx.Response(200, content=self.body))) as client:
            return await self.registry.import_one(record or self.record, self.products, client=client)

    async def test_download_verified_file_and_review_queue_survive_restart(self):
        row = await self.imported()
        self.assertEqual(row['aspect_ratio'], '1:1')
        self.assertEqual(row['matched_product_ids'], ['123'])
        self.assertEqual(row['state'], 'review_required')
        self.assertFalse(row['publication_confirmed'])
        self.assertEqual(len(MediaRegistry(self.audit).list()), 1)
        self.assertEqual((self.registry.root / (row['sha256'] + '.image')).read_bytes(), self.body)

    async def test_missing_imported_file_is_restored_without_new_generation(self):
        row = await self.imported()
        path = self.registry.root / (row['sha256'] + '.image')
        path.unlink()
        self.assertFalse(self.registry.list()[0]['file_available'])
        await self.imported()
        self.assertTrue(path.exists())
        self.assertEqual(len(self.registry.list()), 1)

    async def test_same_job_never_downloaded_again(self):
        await self.imported()
        def handle(_):
            self.fail('Duplicate download')
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            row = await self.registry.import_one(self.record, self.products, client=client)
        self.assertTrue(row['already_imported'])

    async def test_same_bytes_different_jobs_reuse_one_file(self):
        await self.imported()
        await self.imported(record={**self.record, 'job_id': 'b5e44e39-e2a2-409c-a114-26c2e97678ed'})
        self.assertEqual(len(list(self.registry.root.glob('*.image'))), 1)
        self.assertEqual(len(self.registry.list()), 2)

    async def test_unmapped_media_never_becomes_ready_for_publication(self):
        row = await self.imported(record={**self.record, 'product_url': None})
        self.assertEqual(row['state'], 'product_mapping_required')
        self.assertIn('VERIFIED_PRODUCT_MAPPING_REQUIRED', row['blockers'])

    async def test_incomplete_or_untrusted_sources_rejected(self):
        for changes in ({'status': 'pending'}, {'url': 'https://localhost/a.png'},
                        {'url': 'https://d8j0ntlcm91z4.cloudfront.net/a.png?token=secret'}):
            with self.assertRaises(ValueError):
                await self.imported(record={**self.record, **changes})

    async def test_redirect_and_invalid_image_leave_no_durable_success(self):
        for response in (httpx.Response(302, headers={'location': 'https://other.example/'}),
                         httpx.Response(200, content=b'not an image')):
            with self.assertRaises((ValueError, OSError, httpx.HTTPStatusError)):
                await self.imported(response=response)
        self.assertEqual(self.registry.list(), [])
        self.assertEqual(list(self.registry.root.iterdir()), [])

    async def test_oversized_payload_never_enters_queue(self):
        from unittest.mock import patch
        self.assertGreater(MAX_BYTES, len(self.body))
        with patch('adtech_pilot.media_registry.MAX_BYTES', 8), self.assertRaises(ValueError):
            await self.imported()
        self.assertEqual(self.registry.list(), [])
