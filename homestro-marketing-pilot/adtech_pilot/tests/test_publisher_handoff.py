import base64
import json
import unittest
from datetime import UTC, datetime, timedelta

import httpx
from adtech_pilot.publisher_handoff import PublisherHandoff
from adtech_pilot.tests import test_media_registry as fixture


class PublisherHandoffTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.MediaRegistryTests.setUp
    imported = fixture.MediaRegistryTests.imported

    async def test_queue_requires_independent_readback_and_replay_does_not_upload(self):
        asset = await self.imported()
        receipt = {'state': 'queued', 'job_id': asset['job_id'], 'sha256': asset['sha256'],
            'product_id': 'gid://shopify/Product/1', 'requires_visual_review': True,
            'publication_confirmed': False, 'posts': [{'id': 'b5e44e39-e2a2-409c-a114-26c2e97678ed',
                'channel': 'facebook', 'status': 'draft_queued'}]}
        uploaded = False
        calls = []

        def handle(request):
            nonlocal uploaded
            calls.append(request.method)
            self.assertEqual(request.headers['Authorization'], 'Bearer fake-key')
            if request.method == 'POST':
                meta = json.loads(base64.b64decode(request.headers['X-Pilot-Asset-Meta']))
                self.assertEqual(meta['sha256'], asset['sha256'])
                self.assertEqual(request.content, self.body)
                uploaded = True
                return httpx.Response(200, json={'ok': True})
            return httpx.Response(200, json=receipt if uploaded else {'state': 'not_found'})

        now = datetime.now(UTC)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            report = await PublisherHandoff(self.audit).cycle(env={'PILOT_ORGANIC_API_KEY': 'fake-key'}, client=client, now=now)
            self.assertEqual(report['queue_confirmed_assets'], 1)
            self.assertEqual(report['publication_confirmed_assets'], 0)
            self.assertEqual(calls, ['GET', 'POST', 'GET'])
            await PublisherHandoff(self.audit).cycle(env={'PILOT_ORGANIC_API_KEY': 'fake-key'}, client=client, now=now + timedelta(minutes=6))
            self.assertEqual(calls, ['GET', 'POST', 'GET', 'GET'])

    async def test_missing_key_is_offline_and_http_error_is_safely_recorded(self):
        await self.imported()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('Network forbidden'))) as client:
            self.assertEqual((await PublisherHandoff(self.audit).cycle(env={}, client=client))['status'], 'not_configured')
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(403, json={'error': 'AUTH_REQUIRED'}))) as client:
            report = await PublisherHandoff(self.audit).cycle(env={'PILOT_ORGANIC_API_KEY': 'fake-key'}, client=client)
        self.assertEqual(report['results'][0]['reason'], 'AUTH_REQUIRED')
        self.assertEqual(report['queue_confirmed_assets'], 0)

    async def test_wrong_checksum_receipt_never_confirms_queue(self):
        asset = await self.imported()
        with self.assertRaises(ValueError):
            PublisherHandoff.verify_receipt({'job_id': asset['job_id'], 'sha256': '0' * 64}, asset)

    async def test_lost_upload_response_is_reconciled_without_duplicate_upload(self):
        asset = await self.imported()
        posted = False
        writes = 0

        def handle(request):
            nonlocal posted, writes
            if request.method == 'POST':
                posted = True
                writes += 1
                raise httpx.ReadTimeout('uncertain')
            if not posted:
                return httpx.Response(200, json={'state': 'not_found'})
            return httpx.Response(200, json={'state': 'queued', 'job_id': asset['job_id'], 'sha256': asset['sha256'],
                'product_id': 'gid://shopify/Product/1', 'posts': [{'id': asset['job_id'], 'channel': 'facebook', 'status': 'draft_queued'}]})

        now = datetime.now(UTC)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            first = await PublisherHandoff(self.audit).cycle(env={'PILOT_ORGANIC_API_KEY': 'fake-key'}, client=client, now=now)
            self.assertEqual(first['queue_confirmed_assets'], 0)
            second = await PublisherHandoff(self.audit).cycle(env={'PILOT_ORGANIC_API_KEY': 'fake-key'}, client=client, now=now + timedelta(minutes=6))
            self.assertEqual(second['queue_confirmed_assets'], 1)
            self.assertEqual(writes, 1)
