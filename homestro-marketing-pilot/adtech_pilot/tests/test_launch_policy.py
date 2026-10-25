import unittest

from adtech_pilot.purchase_guard import requires_recent_purchase


class LaunchPolicyTests(unittest.TestCase):
    def test_default_and_unknown_policies_keep_purchase_lock(self):
        for env in ({}, {"PILOT_LAUNCH_POLICY": "unknown"}, {"PILOT_LAUNCH_POLICY": "false"}):
            self.assertTrue(requires_recent_purchase(env))

    def test_explicit_acquisition_test_does_not_require_prior_sale(self):
        self.assertFalse(requires_recent_purchase({"PILOT_LAUNCH_POLICY": "bounded_acquisition_test"}))
