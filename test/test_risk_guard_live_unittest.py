"""Standard-library checks for the account-wide live spend guard."""
import unittest

from jarvis_agents.risk_guard_agent import RiskGuardAgent, account_budget_decision


ACCOUNT = "act_918741266442442"


class LiveRiskGuardTests(unittest.TestCase):
    def test_budget_cap_is_account_wide_and_strict(self):
        base = {"account_id": ACCOUNT, "currency": "EUR", "spend_today_eur": 1.0,
                "active_daily_budgets_eur": 3.0, "proposed_daily_budget_eur": 5.0}
        self.assertTrue(account_budget_decision(base)["allowed"])
        base["spend_today_eur"] = 2.0
        decision = account_budget_decision(base)
        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "META_ACCOUNT_DAILY_CAP_REACHED")

    def test_live_ad_requires_switch_account_and_verified_snapshot(self):
        snapshot = {"account_id": ACCOUNT, "currency": "EUR", "spend_today_eur": 1.0,
                    "active_daily_budgets_eur": 2.0, "proposed_daily_budget_eur": 5.0}
        payload = {"live_authorized": True, "account_budget_snapshot": snapshot}
        guard = RiskGuardAgent(env={"AUTONOMOUS_LIVE_MODE": "true", "META_AD_ACCOUNT_ID": ACCOUNT})
        result = guard.validate("campaign_write", payload, 5.0, pillar="homestro")
        self.assertTrue(result["allowed"])
        self.assertFalse(result["dry_run"])
        blocked = RiskGuardAgent(env={"AUTONOMOUS_LIVE_MODE": "false", "META_AD_ACCOUNT_ID": ACCOUNT})
        self.assertEqual(blocked.validate("campaign_write", payload, 5.0, pillar="homestro")["reason"],
                         "EXTERNAL_WRITE_DISABLED")

    def test_seo_write_is_live_only_and_xp6_paid_video_remains_blocked(self):
        live = RiskGuardAgent(env={"AUTONOMOUS_LIVE_MODE": "true", "META_AD_ACCOUNT_ID": ACCOUNT})
        seo = live.validate("shopify_write", {"operation": "seo_sync", "product_status": "ACTIVE",
                                               "external_write": True}, pillar="homestro")
        self.assertTrue(seo["allowed"])
        self.assertFalse(seo["dry_run"])
        video = live.validate("paid_generation", {"product": {"handle": "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5"}},
                              pillar="homestro")
        self.assertEqual(video["reason"], "FLAGSHIP_RUNWAY_GENERATION_FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
