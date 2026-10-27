import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from adtech_pilot.google_writer import GooglePausedWriter
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.search_campaigns import (
    bind_google_targets,
    google_validation_request,
    search_draft,
)


class GoogleWriterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audit = PlanAuditStore(Path(self.tmp.name) / 'audit.sqlite')
        raw = {'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox', 'price': '39.90',
               'currency': 'EUR', 'availability': 'in_stock', 'link': 'https://homestro.de/products/box',
               'image_link': 'https://cdn.shopify.com/box.jpg'}
        self.draft = search_draft(raw, 'google')
        self.env = {'GOOGLE_ADS_CUSTOMER_ID': '1234567890', 'GOOGLE_ADS_ACCESS_TOKEN': 'test',
                    'GOOGLE_ADS_DEVELOPER_TOKEN': 'test', 'GOOGLE_ADS_PAUSED_CREATION_AUTHORIZED': 'true'}
        bundle = google_validation_request(self.draft, '1234567890', proposed_daily_eur=5)
        self.bundle = bind_google_targets(bundle, locations={'DE': 'geoTargetConstants/1', 'AT': 'geoTargetConstants/2'},
                                          german_language='languageConstants/3')

    async def test_no_authorization_never_calls_a_provider(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network'))) as client:
            result = await GooglePausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env={}, client=client)
        self.assertEqual(result['status'], 'disabled')

    async def test_one_atomic_paused_bundle_and_independent_readback_with_no_replay(self):
        import json
        writes = []
        def handle(request):
            if request.url.path.endswith(':mutate'):
                payload = json.loads(request.content)
                self.assertFalse(payload['validateOnly'])
                for operation in payload['mutateOperations']:
                    for obj in operation.values():
                        status = obj['create'].get('status')
                        if status:
                            self.assertEqual(status, 'PAUSED')
                writes.append(payload)
                return httpx.Response(200, json={'mutateOperationResponses': [{'campaignResult': {'resourceName': 'customers/1234567890/campaigns/42'}}]})
            rows = [{'campaign': {'id': '42', 'name': self.draft['campaign_name'], 'status': 'PAUSED'}}] if writes else []
            return httpx.Response(200, json=[{'results': rows}])
        with patch('adtech_pilot.google_writer.validate_google_draft', new=AsyncMock(return_value={
                'status': 'provider_validated_only', 'validated_request': self.bundle})):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result = await GooglePausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
                self.assertEqual(result['status'], 'campaign_paused_confirmed')
                self.assertFalse(result['activation_authorized'])
                again = await GooglePausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
                self.assertEqual(again['status'], 'existing_write_intent')
                self.assertFalse(again['current_remote_state_verified'])
        self.assertEqual(len(writes), 1)

    async def test_lost_response_is_durable_hold_and_no_second_create(self):
        calls = []
        def handle(request):
            if request.url.path.endswith(':mutate'):
                calls.append(request)
                raise httpx.ReadTimeout('lost', request=request)
            return httpx.Response(200, json=[{'results': []}])
        with patch('adtech_pilot.google_writer.validate_google_draft', new=AsyncMock(return_value={
                'status': 'provider_validated_only', 'validated_request': self.bundle})):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                first = await GooglePausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
                self.assertEqual(first['status'], 'write_uncertain')
                await GooglePausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
        self.assertEqual(len(calls), 1)
