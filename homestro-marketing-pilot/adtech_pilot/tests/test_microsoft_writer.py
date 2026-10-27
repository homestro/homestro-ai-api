import json
import tempfile
import unittest
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.microsoft_writer import MicrosoftPausedWriter
from adtech_pilot.search_campaigns import search_draft


class MicrosoftWriterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audit = PlanAuditStore(Path(self.tmp.name) / 'audit.sqlite')
        self.draft = search_draft({'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox',
            'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock', 'link': 'https://homestro.de/products/box',
            'image_link': 'https://cdn.shopify.com/box.jpg'}, 'microsoft')
        self.env = {'MICROSOFT_ADS_ACCOUNT_ID': '123', 'MICROSOFT_ADS_CUSTOMER_ID': '321',
                    'MICROSOFT_ADS_DEVELOPER_TOKEN': 'test', 'MICROSOFT_ADS_ACCESS_TOKEN': 'test',
                    'MICROSOFT_ADS_PAUSED_CREATION_AUTHORIZED': 'true',
                    'MICROSOFT_ADS_COUNTRY_LOCATION_IDS_JSON': '{"DE":"101","AT":"102"}'}

    async def test_unapproved_makes_no_request(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network'))) as client:
            result = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env={}, client=client)
        self.assertEqual(result['status'], 'disabled')

    async def test_dependency_ids_all_paused_and_no_second_create_after_restart(self):
        writes = []
        def handle(request):
            body = json.loads(request.content)
            if request.url.host == 'clientcenter.api.bingads.microsoft.com':
                return httpx.Response(200, json={'Account': {'Id': 123, 'CurrencyCode': 'EUR'}})
            if request.url.path.endswith('/QueryByAccountId'):
                return httpx.Response(200, json={'Campaigns': [{'Id': 42, 'Name': self.draft['campaign_name'], 'Status': 'Paused', 'Languages': ['German']}] if writes else []})
            if request.url.path.endswith('CampaignCriterions/QueryByIds'):
                criteria = ([{'Type': 'LocationCriterion', 'LocationId': n} for n in (101, 102)]
                            if body['CriterionType'] == 'Location' else [{'Type': 'LocationIntentCriterion', 'IntentOption': 'PeopleIn'}])
                return httpx.Response(200, json={'CampaignCriterions': [{'CampaignId': 42, 'Type': 'BiddableCampaignCriterion',
                    'Status': 'Active', 'Criterion': c} for c in criteria]})
            if request.url.path.endswith('AdGroups/QueryByIds'):
                return httpx.Response(200, json={'AdGroups': [{'Id': 43, 'Status': 'Paused', 'Language': 'German'}]})
            if request.url.path.endswith('AdGroupCriterions/QueryByIds'):
                return httpx.Response(200, json={'AdGroupCriterions': []})
            endpoint = request.url.path.rsplit('/', 1)[-1]
            writes.append(endpoint)
            for entity in body[endpoint]:
                if endpoint != 'CampaignCriterions':
                    self.assertEqual(entity['Status'], 'Paused')
            if endpoint == 'CampaignCriterions':
                self.assertEqual(body['CriterionType'], 'Targets')
                self.assertEqual(body[endpoint][0]['Criterion']['IntentOption'], 'PeopleIn')
            if endpoint == 'AdGroups':
                self.assertEqual(body['CampaignId'], 42)
            elif endpoint in {'Ads', 'Keywords'}:
                self.assertEqual(body['AdGroupId'], 43)
            field, ids = {'Campaigns': ('CampaignIds', [42]), 'AdGroups': ('AdGroupIds', [43]),
                          'Ads': ('AdIds', [44]), 'Keywords': ('KeywordIds', [45, 46]),
                          'CampaignCriterions': ('CampaignCriterionIds', [51, 52, 53])}[endpoint]
            return httpx.Response(200, json={field: ids, 'PartialErrors': []})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
            self.assertEqual(result['status'], 'campaign_paused_confirmed')
            self.assertFalse(result['activation_authorized'])
            self.assertFalse(result['targeting_verified'])
            again = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
            self.assertEqual(again['status'], 'existing_write_intent')
        self.assertEqual(writes, ['Campaigns', 'CampaignCriterions', 'AdGroups', 'Ads', 'Keywords'])
        self.assertTrue(result['targeting_readback']['presence_only_confirmed'])
        self.assertTrue(result['targeting_readback']['ad_group_override_readback_verified'])

    async def test_partial_error_keeps_returned_ids_and_never_replays(self):
        writes = []
        def handle(request):
            if request.url.host == 'clientcenter.api.bingads.microsoft.com':
                return httpx.Response(200, json={'Account': {'Id': 123, 'CurrencyCode': 'EUR'}})
            if request.url.path.endswith('/QueryByAccountId'):
                return httpx.Response(200, json={'Campaigns': []})
            writes.append(request)
            return httpx.Response(200, json={'CampaignIds': [42], 'PartialErrors': [{'Code': 1}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
            self.assertEqual(result['status'], 'write_uncertain')
            again = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
            self.assertEqual(again['stored_receipt']['steps']['Campaigns']['returned_ids'], ['42'])
        self.assertEqual(len(writes), 1)

    async def test_lost_child_response_retains_parent_and_blocks_recreation(self):
        writes = []
        def handle(request):
            if request.url.host == 'clientcenter.api.bingads.microsoft.com':
                return httpx.Response(200, json={'Account': {'Id': 123, 'CurrencyCode': 'EUR'}})
            if request.url.path.endswith('/QueryByAccountId'):
                return httpx.Response(200, json={'Campaigns': []})
            writes.append(request.url.path.rsplit('/', 1)[-1])
            if writes[-1] == 'Campaigns':
                return httpx.Response(200, json={'CampaignIds': [42]})
            raise httpx.ReadTimeout('lost', request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            first = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
            self.assertEqual(first['status'], 'write_uncertain')
            held = await MicrosoftPausedWriter(self.audit).create_paused(self.draft, approved_revision=self.draft['revision'], env=self.env, client=client)
        self.assertEqual(held['stored_receipt']['steps']['Campaigns']['ids'], ['42'])
        self.assertEqual(held['stored_receipt']['steps']['CampaignCriterions']['state'], 'intent')
        self.assertEqual(writes, ['Campaigns', 'CampaignCriterions'])
