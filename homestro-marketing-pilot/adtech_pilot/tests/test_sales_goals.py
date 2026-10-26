import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from adtech_pilot.payment_webhooks import PaymentWebhookStore
from adtech_pilot.sales_goals import sales_goal_progress


class SalesGoalsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = PaymentWebhookStore(Path(self.directory.name) / 'payments.sqlite')

    def add_order(self, key, at, *, blocked=0, channel='facebook'):
        with closing(self.store.connect()) as db, db:
            db.execute('''INSERT INTO pilot_order_economics
                (order_hash,campaign,ad,experiment,paid_at,net_revenue,cogs,blocked,channel)
                VALUES (?,?,?,?,?,?,?,?,?)''', (key, '12345', '23456', 'a' * 24, at, '40', '10', blocked, channel))

    def test_empty_does_not_mean_zero_shop_sales_or_proven_profit(self):
        result = sales_goal_progress(self.store, now=datetime(2026, 10, 26, 8, tzinfo=UTC))
        self.assertEqual(result['goal']['orders_per_day'], 10)
        self.assertEqual(result['orders_remaining'], 10)
        self.assertIsNone(result['all_shop_orders'])
        self.assertIsNone(result['actual_net_profit_eur'])
        self.assertFalse(result['spend_authorized'])

    def test_berlin_day_counts_organic_and_paid_but_excludes_future_cancelled_and_previous_day(self):
        self.add_order('today', '2026-10-25T23:00:00+00:00')
        self.add_order('paid', '2026-10-26T06:00:00+00:00', channel='meta')
        self.add_order('previous', '2026-10-25T22:59:59+00:00')
        self.add_order('cancelled', '2026-10-26T06:00:00+00:00', blocked=1)
        self.add_order('future', '2026-10-26T12:00:00+00:00')
        result = sales_goal_progress(self.store, now=datetime(2026, 10, 26, 8, tzinfo=UTC))
        self.assertEqual(result['signed_attributed_paid_orders'], 2)
        self.assertEqual(result['refund_or_cancelled_orders'], 1)
        self.assertEqual(result['orders_remaining'], 8)
        self.assertFalse(result['profit_goal_verified'])

    def test_dst_uses_local_day_boundaries_instead_of_fixed_24_hours(self):
        result = sales_goal_progress(self.store, now=datetime(2026, 10, 25, 12, tzinfo=UTC))
        self.assertEqual(result['window_start'], '2026-10-24T22:00:00+00:00')
        self.assertEqual(result['window_end'], '2026-10-25T23:00:00+00:00')

    def test_orders_target_never_unlocks_spending_or_claims_profit(self):
        for i in range(10):
            self.add_order(str(i), '2026-10-26T06:00:00+00:00')
        result = sales_goal_progress(self.store, now=datetime(2026, 10, 26, 8, tzinfo=UTC))
        self.assertTrue(result['order_goal_reached'])
        self.assertFalse(result['budget_increase_authorized'])
        self.assertFalse(result['profit_goal_verified'])
        self.assertEqual(result['orders_remaining'], 0)
