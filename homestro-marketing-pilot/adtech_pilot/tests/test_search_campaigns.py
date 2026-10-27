import copy
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.search_campaigns import (
    SearchCampaignDrafts,
    bind_google_targets,
    google_validation_request,
    microsoft_request_templates,
    search_draft,
    validate_google_draft,
)


class SearchCampaignTests(unittest.TestCase):
    def setUp(self):
        self.raw = {'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox',
            'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
            'link': 'https://homestro.de/products/box?variant=123', 'image_link': 'https://cdn.shopify.com/box.jpg'}

    def test_google_dependent_bundle_cannot_execute_and_all_entities_are_paused(self):
        draft = search_draft(self.raw, 'google')
        request = google_validation_request(draft, '1234567890', proposed_daily_eur='5.00')
        self.assertIs(request['validateOnly'], True)
        operations = request['mutateOperations']
        self.assertEqual(operations[1]['campaignOperation']['create']['status'], 'PAUSED')
        self.assertEqual(operations[2]['adGroupOperation']['create']['status'], 'PAUSED')
        self.assertEqual(operations[3]['adGroupAdOperation']['create']['status'], 'PAUSED')
        self.assertEqual({x['adGroupCriterionOperation']['create']['keyword']['matchType'] for x in operations[4:]}, {'EXACT', 'PHRASE'})
        self.assertFalse(draft['keyword_demand_verified'])
        self.assertEqual(draft['budget_authorized_eur'], '0.00')

    def test_target_binding_requires_both_countries_and_preserves_validate_only(self):
        request = google_validation_request(search_draft(self.raw, 'google'), '1234567890', proposed_daily_eur=5)
        for locations in ({}, {'DE': 'geoTargetConstants/1'}, {'DE': 'invalid', 'AT': 'geoTargetConstants/2'}):
            with self.assertRaises(ValueError):
                bind_google_targets(request, locations=locations, german_language='languageConstants/1')
        result = bind_google_targets(request, locations={'DE': 'geoTargetConstants/1', 'AT': 'geoTargetConstants/2'}, german_language='languageConstants/3')
        self.assertIs(result['validateOnly'], True)
        self.assertEqual(len(result['mutateOperations']), len(request['mutateOperations']) + 3)
        self.assertEqual(len(request['mutateOperations']), 6)

    def test_bing_schema_templates_explicitly_hold_unresolved_dependencies_and_no_network(self):
        result = microsoft_request_templates(search_draft(self.raw, 'microsoft'), '123', proposed_daily_eur=5)
        self.assertFalse(result['ready_to_submit'])
        self.assertFalse(result['writes_performed'])
        self.assertEqual(result['requests'][0]['body']['Campaigns'][0]['Status'], 'Paused')
        self.assertEqual(result['requests'][2]['body']['Ads'][0]['Headlines'][0]['Asset']['Type'], 'TextAsset')
        self.assertIn('VERIFIED_DE_AT_LOCATION_IDS', result['unresolved'])

    def test_tampered_copy_country_or_budget_never_compiles(self):
        draft = search_draft(self.raw, 'google')
        for key, value in [('headlines', ['Invented']), ('countries', ['US']), ('budget_authorized_eur', '5.00')]:
            changed = copy.deepcopy(draft)
            changed[key] = value
            with self.assertRaises(ValueError):
                google_validation_request(changed, '1234567890', proposed_daily_eur=5)
        for budget in ('NaN', '-1', '0', '5.01', '1.001'):
            with self.assertRaises(ValueError):
                google_validation_request(draft, '1234567890', proposed_daily_eur=budget)

    def test_durable_reconcile_updates_revisions_deduplicates_variants_and_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = PlanAuditStore(Path(directory) / 'audit.sqlite')
            now = datetime.now(UTC)
            store = SearchCampaignDrafts(audit)
            result = store.reconcile([self.raw, {**self.raw, 'id': '124', 'link': 'https://homestro.de/products/box?variant=124'}], now=now)
            self.assertEqual(result['draft_count'], 2)
            before = SearchCampaignDrafts(audit).list(now=now)
            self.assertEqual(len(before), 2)
            store.reconcile([{**self.raw, 'price': '40.90'}], now=now)
            after = store.list(now=now)
            self.assertEqual([x['id'] for x in before], [x['id'] for x in after])
            self.assertNotEqual(before[0]['revision'], after[0]['revision'])
            self.assertEqual(store.list(now=now + timedelta(hours=7)), [])
            store.reconcile([], now=now)
            self.assertEqual(store.list(now=now), [])

    def test_invalid_feed_and_unreviewable_keyword_do_not_become_campaigns(self):
        for changes in ({'availability': 'out_of_stock'}, {'title': 'x ' * 11}, {'link': 'https://other.example/box'}):
            with self.assertRaises(ValueError):
                search_draft({**self.raw, **changes}, 'google')


class GoogleValidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_validation_never_calls_provider(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('Network forbidden'))) as client:
            self.assertEqual((await validate_google_draft({}, proposed_daily_eur=5, env={}, client=client))['status'], 'disabled')
            self.assertEqual((await validate_google_draft({}, proposed_daily_eur=5,
                env={'GOOGLE_ADS_VALIDATE_ONLY_ENABLED': 'true'}, client=client))['status'], 'not_configured')

    async def test_provider_validation_resolves_actual_targets_and_never_executes(self):
        raw = {'id': '123', 'title': 'Aufbewahrungsbox', 'price': '39.90', 'currency': 'EUR',
            'availability': 'in_stock', 'link': 'https://homestro.de/products/box', 'image_link': 'https://cdn.shopify.com/box.jpg'}
        calls = []

        def handle(request):
            self.assertEqual(request.url.host, 'googleads.googleapis.com')
            body = json.loads(request.content)
            calls.append(body)
            if request.url.path.endswith(':mutate'):
                self.assertIs(body['validateOnly'], True)
                self.assertFalse(body['partialFailure'])
                self.assertEqual(len(body['mutateOperations']), 9)
                return httpx.Response(200, json={})
            query = body['query']
            if 'FROM customer' in query:
                result = [{'customer': {'id': '1234567890', 'currencyCode': 'EUR'}}]
            elif 'geo_target_constant' in query:
                result = [{'geoTargetConstant': {'countryCode': code, 'resourceName': 'geoTargetConstants/' + str(i)}} for i, code in enumerate(('DE', 'AT'), 1)]
            else:
                result = [{'languageConstant': {'code': 'de', 'resourceName': 'languageConstants/3'}}]
            return httpx.Response(200, json=[{'results': result}])

        env = {'GOOGLE_ADS_VALIDATE_ONLY_ENABLED': 'true', 'GOOGLE_ADS_CUSTOMER_ID': '1234567890',
            'GOOGLE_ADS_DEVELOPER_TOKEN': 'fake', 'GOOGLE_ADS_ACCESS_TOKEN': 'fake'}
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await validate_google_draft(search_draft(raw, 'google'), proposed_daily_eur=5, env=env, client=client)
        self.assertEqual(result['status'], 'provider_validated_only')
        self.assertFalse(result['writes_performed'])
        self.assertEqual(len(calls), 4)
