import json
import unittest

import httpx
from adtech_pilot.channel_control import allocation_plan, pause_search_campaign


class BudgetTests(unittest.TestCase):
    def test_one_global_budget_never_becomes_three_separate_tests(self):
        row = {'currency': 'EUR', 'fresh': True, 'costs_complete': True, 'signed_orders_verified': True,
               'channel_spend_authorized': True, 'common_window_verified': True, 'orders': 3,
               'contribution_after_ads_eur': '10', 'spend_eur': '5'}
        observations = {channel: dict(row) for channel in ('meta', 'google', 'microsoft')}
        observations['google']['contribution_after_ads_eur'] = '15'
        result = allocation_plan(observations, authorized_daily_eur='5', measurement_verified=True)
        self.assertEqual(result['allocated_daily_eur'], '5.00')
        self.assertEqual([r['proposed_daily_eur'] for r in result['channels']], ['0.00', '5.00', '0.00'])
        self.assertFalse(result['writes_performed'])
        self.assertFalse(result['scale_authorized'])
        for flag in ('fresh', 'costs_complete', 'signed_orders_verified', 'channel_spend_authorized', 'common_window_verified'):
            for item in observations.values():
                item[flag] = False
            self.assertEqual(allocation_plan(observations, authorized_daily_eur='5', measurement_verified=True)['allocated_daily_eur'], '0.00')
            for item in observations.values():
                item[flag] = True
        self.assertEqual(allocation_plan(observations, authorized_daily_eur='5')['allocated_daily_eur'], '0.00')
        for bad in ('NaN', 'Infinity', '-1', '5.01', '4.999'):
            with self.assertRaises(ValueError):
                allocation_plan({}, authorized_daily_eur=bad)


class StopTests(unittest.IsolatedAsyncioTestCase):
    async def test_unconfigured_disabled_and_wrong_account_never_write(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('unexpected network'))) as client:
            result = await pause_search_campaign('google', '123', expected_account='1234567890', env={}, client=client)
            self.assertEqual(result['reason'], 'CONFIGURED_ACCOUNT_MISMATCH')
            result = await pause_search_campaign('google', '123', expected_account='1234567890',
                env={'GOOGLE_ADS_CUSTOMER_ID': '1234567890'}, client=client)
            self.assertEqual(result['status'], 'not_configured')

    async def test_google_stop_never_enables_or_changes_budget_and_requires_readback(self):
        env = {'GOOGLE_ADS_CUSTOMER_ID': '1234567890', 'GOOGLE_ADS_ACCESS_TOKEN': 'test',
               'GOOGLE_ADS_DEVELOPER_TOKEN': 'test', 'PILOT_SEARCH_STOP_WRITES_ENABLED': 'true'}
        def handle(request):
            body = json.loads(request.content)
            if request.url.path.endswith('campaigns:mutate'):
                self.assertEqual(body['operations'], [{'updateMask': 'status', 'update': {
                    'resourceName': 'customers/1234567890/campaigns/123', 'status': 'PAUSED'}}])
                return httpx.Response(200, json={'results': [{'resourceName': 'customers/1234567890/campaigns/123'}]})
            self.assertIn('campaign.id = 123', body['query'])
            return httpx.Response(200, json=[{'results': [{'campaign': {'id': '123', 'status': 'PAUSED'}}]}])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await pause_search_campaign('google', '123', expected_account='1234567890', env=env, client=client)
        self.assertEqual(result['status'], 'paused_confirmed')
        self.assertEqual(result['campaigns_created'], 0)

    async def test_microsoft_sparse_put_partial_errors_and_lost_reply_are_unconfirmed(self):
        env = {'MICROSOFT_ADS_ACCOUNT_ID': '123', 'MICROSOFT_ADS_CUSTOMER_ID': '321',
               'MICROSOFT_ADS_DEVELOPER_TOKEN': 'test', 'MICROSOFT_ADS_ACCESS_TOKEN': 'test',
               'PILOT_SEARCH_STOP_WRITES_ENABLED': 'true'}
        for partial in (False, True):
            def handle(request):
                if request.method == 'PUT':
                    self.assertEqual(json.loads(request.content), {'AccountId': 123, 'Campaigns': [{'Id': 42, 'Status': 'Paused'}]})
                    return httpx.Response(200, json={'PartialErrors': [{'Code': 1}] if partial else []})
                return httpx.Response(200, json={'Campaigns': [{'Id': 42, 'Status': 'Paused'}]})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result = await pause_search_campaign('microsoft', '42', expected_account='123', env=env, client=client)
            self.assertEqual(result['status'], 'pause_unconfirmed' if partial else 'paused_confirmed')
        def lost(request):
            raise httpx.ReadTimeout('lost', request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lost)) as client:
            result = await pause_search_campaign('microsoft', '42', expected_account='123', env=env, client=client)
        self.assertEqual(result['status'], 'pause_unconfirmed')
        self.assertTrue(result['writes_performed'])
