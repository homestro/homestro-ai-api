import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from adtech_pilot.channel_accounting import accounting_observations, common_window
from adtech_pilot.channel_control import allocation_plan
from adtech_pilot.payment_webhooks import PaymentWebhookStore


class ChannelAccountingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = PaymentWebhookStore(Path(self.tmp.name) / 'payment.sqlite')
        self.now = datetime(2026, 10, 26, 12, tzinfo=UTC)
        start, end = common_window(self.now)
        with self.store.connect() as db:
            for key, at in [('inside', start), ('outside', end)]:
                db.execute('INSERT INTO pilot_order_economics(order_hash,campaign,ad,experiment,paid_at,net_revenue,cogs,channel) '
                           'VALUES(?,?,?,?,?,?,?,?)', (key, '42', '43', 'test', at, '40.00', '10.00', 'google'))
                db.execute('INSERT INTO pilot_order_expenses VALUES(?,?,?,?,?,?)', (key, '4.00', '1.00', '0.00', '0.00', at))
        self.source = {'status': 'observed', 'currency': 'EUR', 'observed_at': self.now.isoformat(),
            'window_start': start, 'window_end': end, 'window_timezone': 'UTC',
            'report_complete': True, 'campaign_scope_verified': True, 'owned_campaign_ids': ['42'],
            'campaigns': [{'id': '42', 'cost_micros': '5000000', 'reported_conversions': '1000'}]}

    def test_same_window_order_costs_and_real_spend_reach_optimizer_without_budget_authority(self):
        result = accounting_observations(self.store, {'google': self.source}, now=self.now)
        google = result['google']
        self.assertEqual(google['orders'], 1)  # exclusive end: no accidental next-day order
        self.assertEqual(google['contribution_after_ads_eur'], '20.00')
        self.assertEqual(google['spend_eur'], '5')
        self.assertTrue(google['common_window_verified'])
        self.assertTrue(google['costs_complete'])
        self.assertFalse(google['channel_spend_authorized'])
        self.assertFalse(google['net_profit_verified'])
        self.assertEqual(allocation_plan(result)['allocated_daily_eur'], '0.00')
        self.assertEqual(allocation_plan(result, authorized_daily_eur='5', measurement_verified=True)['allocated_daily_eur'], '0.00')

    def test_mismatched_window_stale_scope_missing_costs_and_duplicate_metrics_cannot_be_winners(self):
        for patch in ({'window_start': None}, {'window_timezone': 'America/Los_Angeles'},
                      {'observed_at': (self.now-timedelta(hours=2)).isoformat()}, {'owned_campaign_ids': ['99']},
                      {'campaigns': self.source['campaigns'] * 2}, {'currency': 'USD'}):
            google = accounting_observations(self.store, {'google': {**self.source, **patch}}, now=self.now)['google']
            self.assertIsNone(google['contribution_after_ads_eur'])
        with self.store.connect() as db:
            db.execute("DELETE FROM pilot_order_expenses WHERE order_hash='inside'")
        google = accounting_observations(self.store, {'google': self.source}, now=self.now)['google']
        self.assertFalse(google['costs_complete'])
        self.assertIsNone(google['contribution_after_ads_eur'])

    def test_current_lifetime_or_undated_provider_readouts_remain_explicitly_unaligned(self):
        providers = {'google': {'status': 'observed', 'currency': 'EUR', 'campaigns': self.source['campaigns'], 'window': 'LAST_7_DAYS_ACCOUNT_TIMEZONE'},
            'microsoft': {'status': 'not_configured'}, 'meta': {'status': 'collected', 'metrics': [{'campaign_id': '12', 'spend_eur': '12.65'}], 'window': 'maximum'}}
        results = accounting_observations(self.store, providers, now=self.now)
        self.assertEqual(results['meta']['spend_eur'], '12.65')
        self.assertIsNone(results['microsoft']['spend_eur'])
        self.assertTrue(all(not row['common_window_verified'] for row in results.values()))
        self.assertTrue(all(row['contribution_after_ads_eur'] is None for row in results.values()))


    def test_malformed_channel_evidence_does_not_stop_healthy_channel_accounting(self):
        for malformed in (['bad'], 'bad', 123, {'owned_campaign_ids': [{}], 'metrics': 1},
                          {'owned_campaign_ids': ['12'], 'metrics': 'bad'}):
            with self.subTest(malformed=malformed):
                result = accounting_observations(self.store, {'meta': malformed, 'google': self.source}, now=self.now)
                self.assertEqual(result['google']['contribution_after_ads_eur'], '20.00')
                self.assertIsNone(result['meta']['contribution_after_ads_eur'])
                self.assertFalse(result['meta']['common_window_verified'])

    def test_every_owned_campaign_requires_explicit_spend_including_zero(self):
        for patch in ({'owned_campaign_ids': ['42', '99']}, {'owned_campaign_ids': ['42', '42']},
                      {'owned_campaign_ids': [{}]}, {'campaigns': 5}):
            with self.subTest(patch=patch):
                result = accounting_observations(self.store, {'google': {**self.source, **patch}}, now=self.now)['google']
                self.assertFalse(result['common_window_verified'])
                self.assertIsNone(result['contribution_after_ads_eur'])
        explicit_zero = {**self.source, 'owned_campaign_ids': ['42', '99'],
                         'campaigns': self.source['campaigns'] + [{'id': '99', 'cost_micros': '0'}]}
        result = accounting_observations(self.store, {'google': explicit_zero}, now=self.now)['google']
        self.assertTrue(result['common_window_verified'])
        self.assertEqual(result['contribution_after_ads_eur'], '20.00')
