import unittest

from adtech_pilot.performance_loader import performance_decision


def snapshot(spend, purchases=0, value=0, window='maximum'):
    return {'status': 'collected', 'window': window, 'metrics': [{
        'spend_eur': spend, 'reported_purchases': purchases, 'reported_purchase_value_eur': value}]}


class PerformancePolicyTests(unittest.TestCase):
    def test_no_delivery_is_not_bad_performance(self):
        self.assertEqual(performance_decision({'status': 'collected', 'metrics': []})['reason'], 'NO_DELIVERY_DATA')
        self.assertIsNone(performance_decision(snapshot(0))['reported_roas'])

    def test_stop_threshold_is_strict_and_counts_reported_purchases(self):
        self.assertEqual(performance_decision(snapshot(15))['action'], 'hold')
        self.assertEqual(performance_decision(snapshot('15.01'))['reason'], 'SPEND_OVER_15_WITH_NO_REPORTED_PURCHASE')
        self.assertEqual(performance_decision(snapshot(16, 1, 40))['action'], 'hold')

    def test_total_stop_wins_even_with_high_roas(self):
        self.assertEqual(performance_decision(snapshot(35, 5, 200))['reason'], 'TEST_TOTAL_BUDGET_REACHED')

    def test_high_roas_cannot_raise_budget_or_claim_profit(self):
        result = performance_decision(snapshot(10, 3, 30))
        self.assertEqual(result['reported_roas'], 3)
        self.assertEqual(result['uncapped_proposal_eur'], 6)
        self.assertEqual(result['allowed_daily_budget_eur'], 5)
        self.assertFalse(result['budget_write_authorized'])
        self.assertFalse(result['attribution_verified'])

    def test_yesterday_cannot_replace_lifetime_stop_evidence(self):
        self.assertEqual(performance_decision(snapshot(16, window='yesterday'))['reason'], 'LIFETIME_WINDOW_REQUIRED')

    def test_unreadable_ambiguous_invalid_metrics_do_not_activate(self):
        for result in ({'status': 'unavailable'}, {'status': 'collected', 'metrics': [{}, {}]},
                       snapshot('NaN'), snapshot(-1), snapshot(10, -2), snapshot(10, 1, 'Infinity')):
            self.assertEqual(performance_decision(result)['action'], 'pause')

    def test_authorization_above_five_is_not_inferred_from_provided_code(self):
        result = performance_decision(snapshot(10, 3, 50), current_daily_budget_eur=6, daily_cap_eur=100)
        self.assertEqual(result['reason'], 'DAILY_BUDGET_EXCEEDS_AUTHORIZATION')
