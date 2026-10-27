import unittest

from adtech_pilot.purchase_guard import requires_recent_purchase


class LaunchPolicyTests(unittest.TestCase):
    def test_default_and_unknown_policies_keep_purchase_lock(self):
        for env in ({}, {"PILOT_LAUNCH_POLICY": "unknown"}, {"PILOT_LAUNCH_POLICY": "false"}):
            self.assertTrue(requires_recent_purchase(env))

    def test_explicit_acquisition_test_does_not_require_prior_sale(self):
        self.assertFalse(requires_recent_purchase({"PILOT_LAUNCH_POLICY": "bounded_acquisition_test"}))


class MeasurementRiskTests(unittest.TestCase):
    def test_waiver_requires_both_explicit_flags(self):
        from adtech_pilot.micro_budget import measurement_risk_accepted
        self.assertFalse(measurement_risk_accepted({}))
        self.assertFalse(measurement_risk_accepted({"PILOT_ACCEPT_UNVERIFIED_MEASUREMENT": "true"}))
        self.assertFalse(measurement_risk_accepted({"PILOT_LAUNCH_POLICY": "bounded_acquisition_test"}))
        self.assertTrue(measurement_risk_accepted({"PILOT_LAUNCH_POLICY": "bounded_acquisition_test", "PILOT_ACCEPT_UNVERIFIED_MEASUREMENT": "true"}))

    def test_waiver_keeps_other_gates_closed(self):
        from adtech_pilot.micro_budget import MicroBudgetGate
        decision = MicroBudgetGate(enabled=False).evaluate(account=None, product_ids_in_feed=set(), unverified_measurement_test_authorized=True)
        self.assertNotIn("META_PURCHASE_EVENT_NOT_VERIFIED", decision.blockers)
        for blocker in ("DRY_RUN_ENABLED", "MICRO_BUDGET_NOT_EXPLICITLY_ENABLED", "META_ACCOUNT_PREFLIGHT_NOT_VERIFIED", "NO_VALIDATED_CATALOG_PRODUCTS"):
            self.assertIn(blocker, decision.blockers)
