import unittest

from adtech_pilot.micro_budget import MetaAccountReadiness, MicroBudgetGate


class MicroBudgetGateTests(unittest.TestCase):
    def setUp(self):
        self.active_account = MetaAccountReadiness(
            account_id="act_123",
            account_status="active",
            currency="EUR",
            billing_ready=True,
            page_id="123",
            pixel_id="456",
            conversion_event_verified=True,
        )

    def test_default_gate_is_closed_and_spend_is_zero(self):
        result = MicroBudgetGate(enabled=False).evaluate(
            account=self.active_account,
            product_id="sku-1",
            product_ids_in_feed={"sku-1"},
        )
        self.assertFalse(result.eligible)
        self.assertEqual(result.daily_budget_eur, 0)
        self.assertFalse(result.live_submission_enabled)

    def test_verified_configuration_is_limited_to_one_five_euro_meta_campaign(self):
        result = MicroBudgetGate(enabled=True).evaluate(
            account=self.active_account,
            product_id="sku-1",
            product_ids_in_feed={"sku-1"},
        )
        self.assertTrue(result.eligible)
        self.assertEqual(result.platform, "meta")
        self.assertEqual(result.daily_budget_eur, 5.0)
        self.assertEqual(result.max_campaigns, 1)
        self.assertFalse(result.live_submission_enabled)

    def test_missing_validation_product_or_used_allowance_fails_closed(self):
        cases = [
            {"account": None, "product_id": "sku-1", "product_ids_in_feed": {"sku-1"}},
            {"account": self.active_account, "product_id": "sku-2", "product_ids_in_feed": {"sku-1"}},
            {"account": self.active_account, "product_id": "sku-1", "product_ids_in_feed": {"sku-1"}, "previously_submitted_campaigns": 1},
        ]
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                result = MicroBudgetGate(enabled=True).evaluate(**kwargs)
                self.assertFalse(result.eligible)
                self.assertEqual(result.daily_budget_eur, 0.0)


if __name__ == "__main__":
    unittest.main()
