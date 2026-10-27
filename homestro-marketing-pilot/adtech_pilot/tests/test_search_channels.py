import json
import unittest

import httpx
from adtech_pilot.search_channels import read_google, read_microsoft


class SearchReadersTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_connection_configuration_makes_no_network_call(self):
        def handle(_):
            self.fail('Unexpected provider request')
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            for read in (read_google, read_microsoft):
                result = await read(env={}, client=client)
                self.assertEqual(result['status'], 'not_configured')
                self.assertFalse(result['writes_performed'])

    async def test_google_refresh_and_reports_use_only_official_read_endpoint(self):
        calls = []
        def handle(request):
            calls.append(request)
            if request.url.host == 'oauth2.googleapis.com':
                return httpx.Response(200, json={'access_token': 'fresh'})
            self.assertTrue(request.url.path.endswith('googleAds:searchStream'))
            self.assertEqual(request.headers['authorization'], 'Bearer fresh')
            query = json.loads(request.content)['query']
            if 'FROM customer' in query:
                return httpx.Response(200, json=[{'results': [{'customer': {'id': '1234567890', 'currencyCode': 'EUR', 'timeZone': 'Europe/Berlin'}}]}])
            return httpx.Response(200, json=[{'results': [{'campaign': {'id': '12', 'name': 'Existing', 'status': 'PAUSED'},
                'metrics': {'costMicros': '1500000', 'conversions': '2'}}]}])
        env = {'GOOGLE_ADS_CUSTOMER_ID': '123-456-7890', 'GOOGLE_ADS_DEVELOPER_TOKEN': 'developer',
               'GOOGLE_ADS_CLIENT_ID': 'client', 'GOOGLE_ADS_CLIENT_SECRET': 'secret', 'GOOGLE_ADS_REFRESH_TOKEN': 'refresh'}
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await read_google(env=env, client=client)
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['campaigns'][0]['cost_micros'], '1500000')
        self.assertTrue(result['conversions_are_not_verified_purchases'])
        self.assertFalse(result['writes_performed'])
        self.assertEqual(len(calls), 3)

    async def test_microsoft_inventory_query_has_no_mutation_or_performance_claim(self):
        def handle(request):
            self.assertTrue(str(request.url).endswith('/Campaigns/QueryByAccountId'))
            self.assertEqual(request.headers['CustomerAccountId'], '123')
            self.assertEqual(json.loads(request.content)['AccountId'], 123)
            return httpx.Response(200, json={'Campaigns': [{'Id': 42, 'Name': 'Existing', 'Status': 'Paused'}]})
        env = {'MICROSOFT_ADS_ACCOUNT_ID': '123', 'MICROSOFT_ADS_CUSTOMER_ID': '321',
               'MICROSOFT_ADS_DEVELOPER_TOKEN': 'developer', 'MICROSOFT_ADS_ACCESS_TOKEN': 'existing'}
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await read_microsoft(env=env, client=client)
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['performance_metrics_available'])
        self.assertFalse(result['writes_performed'])
