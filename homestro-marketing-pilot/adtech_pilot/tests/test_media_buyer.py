import asyncio
import unittest

from pydantic import ValidationError

from adtech_pilot.media_buyer import (
    ActionType,
    AdExecutionEngine,
    BudgetAction,
    MetricSnapshot,
    OptimizationPlan,
    Platform,
    build_optimization_plan,
)


class RecordingAdapter:
    def __init__(self):
        self.calls = []

    async def apply_action(self, action):
        self.calls.append(action)
        return {"ok": True}


class MediaBuyerTests(unittest.TestCase):
    def test_unverified_attribution_never_recommends_scaling(self):
        metric = MetricSnapshot(
            platform="meta",
            campaign_id="m1",
            daily_budget_eur=20,
            spend_eur=100,
            revenue_eur=500,
            conversions=5,
            clicks=100,
            impressions=3000,
        )
        plan = build_optimization_plan([metric], current_portfolio_daily_budget_eur=20)
        self.assertFalse(plan.attribution_verified)
        self.assertEqual(plan.actions[0].action, ActionType.HOLD)

    def test_cross_channel_transfer_is_recommendation_not_budget_creation(self):
        loser = MetricSnapshot(
            platform="meta",
            campaign_id="m1",
            daily_budget_eur=20,
            spend_eur=100,
            revenue_eur=10,
            conversions=1,
            clicks=100,
            impressions=4000,
            contribution_margin_eur=1,
            attribution_verified=True,
        )
        winner = MetricSnapshot(
            platform="google",
            campaign_id="g1",
            daily_budget_eur=20,
            spend_eur=100,
            revenue_eur=600,
            conversions=8,
            clicks=200,
            impressions=5000,
            contribution_margin_eur=200,
            attribution_verified=True,
        )
        plan = build_optimization_plan(
            [loser, winner], current_portfolio_daily_budget_eur=40
        )
        self.assertTrue(any(a.action == ActionType.REALLOCATE for a in plan.actions))
        self.assertEqual(plan.proposed_portfolio_daily_budget_eur, 40)

    def test_default_engine_is_dry_run_and_never_calls_adapter(self):
        action = BudgetAction(
            platform="meta",
            campaign_id="m1",
            action="INCREASE_BUDGET",
            amount_eur=5,
            rationale="Verified profitable campaign",
        )
        plan = OptimizationPlan(
            attribution_verified=True,
            current_portfolio_daily_budget_eur=10,
            proposed_portfolio_daily_budget_eur=15,
            actions=[action],
        )
        adapter = RecordingAdapter()
        result = asyncio.run(
            AdExecutionEngine().execute(plan, {Platform.META: adapter})
        )
        self.assertTrue(result.dry_run)
        self.assertFalse(result.mutation_performed)
        self.assertEqual(result.blocked_reason, "DRY_RUN_ENABLED")
        self.assertEqual(adapter.calls, [])

    def test_over_limit_plan_never_calls_adapter(self):
        action = BudgetAction(
            platform="meta",
            campaign_id="m1",
            action="INCREASE_BUDGET",
            amount_eur=5,
            rationale="Verified profitable campaign",
        )
        plan = OptimizationPlan(
            attribution_verified=True,
            current_portfolio_daily_budget_eur=10,
            proposed_portfolio_daily_budget_eur=15,
            actions=[action],
        )
        adapter = RecordingAdapter()
        result = asyncio.run(
            AdExecutionEngine(dry_run=False, max_budget_limit=12).execute(
                plan, {Platform.META: adapter}
            )
        )
        self.assertEqual(result.blocked_reason, "MAX_BUDGET_LIMIT_EXCEEDED")
        self.assertEqual(adapter.calls, [])

    def test_forged_total_cannot_hide_an_over_limit_increase(self):
        with self.assertRaises(ValidationError):
            OptimizationPlan(
                attribution_verified=True,
                current_portfolio_daily_budget_eur=0,
                proposed_portfolio_daily_budget_eur=0,
                actions=[
                    BudgetAction(
                        platform="meta",
                        campaign_id="m1",
                        action="INCREASE_BUDGET",
                        amount_eur=100,
                        rationale="A forged plan",
                    )
                ],
            )

    def test_dry_run_false_still_requires_a_real_adapter(self):
        action = BudgetAction(
            platform="meta",
            campaign_id="m1",
            action="INCREASE_BUDGET",
            amount_eur=5,
            rationale="Verified profitable campaign",
        )
        plan = OptimizationPlan(
            attribution_verified=True,
            current_portfolio_daily_budget_eur=10,
            proposed_portfolio_daily_budget_eur=15,
            actions=[action],
        )
        result = asyncio.run(
            AdExecutionEngine(dry_run=False, max_budget_limit=20).execute(plan, {})
        )
        self.assertEqual(result.blocked_reason, "PLATFORM_ADAPTER_MISSING")
        self.assertFalse(result.mutation_performed)

    def test_multi_action_budget_saga_is_blocked_before_any_provider_write(self):
        actions = [
            BudgetAction(
                platform="meta",
                campaign_id="m1",
                action="REDUCE_BUDGET",
                amount_eur=5,
                rationale="Free budget from weak campaign",
            ),
            BudgetAction(
                platform="meta",
                campaign_id="m2",
                action="INCREASE_BUDGET",
                amount_eur=5,
                rationale="Scale verified campaign",
            ),
        ]
        plan = OptimizationPlan(
            attribution_verified=True,
            current_portfolio_daily_budget_eur=20,
            proposed_portfolio_daily_budget_eur=20,
            actions=actions,
        )
        adapter = RecordingAdapter()
        result = asyncio.run(
            AdExecutionEngine(dry_run=False, max_budget_limit=20).execute(
                plan, {Platform.META: adapter}
            )
        )
        self.assertEqual(result.blocked_reason, "MULTI_ACTION_REQUIRES_SAGA")
        self.assertEqual(adapter.calls, [])

    def test_budget_transfer_waits_for_a_saga_adapter(self):
        action = BudgetAction(
            platform="google",
            campaign_id="g1",
            source_platform="meta",
            source_campaign_id="m1",
            action="REALLOCATE_BUDGET",
            amount_eur=2,
            rationale="Shift only after verified performance",
        )
        plan = OptimizationPlan(
            attribution_verified=True,
            current_portfolio_daily_budget_eur=10,
            proposed_portfolio_daily_budget_eur=10,
            actions=[action],
        )
        result = asyncio.run(
            AdExecutionEngine(dry_run=False, max_budget_limit=10).execute(plan, {})
        )
        self.assertEqual(result.blocked_reason, "BUDGET_TRANSFER_REQUIRES_SAGA")


if __name__ == "__main__":
    unittest.main()
