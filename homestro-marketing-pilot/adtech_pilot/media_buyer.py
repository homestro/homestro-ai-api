"""Performance analysis, competitor intelligence and budget-safe media execution."""

from __future__ import annotations

import asyncio
import json
import math
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field, model_validator


class Platform(StrEnum):
    META = "meta"
    GOOGLE = "google"
    TIKTOK = "tiktok"
    PINTEREST = "pinterest"
    MICROSOFT = "microsoft"
    SKLIK = "sklik"


class MetricSnapshot(BaseModel):
    platform: Platform
    campaign_id: str
    campaign_name: str = ""
    daily_budget_eur: float = Field(ge=0)
    spend_eur: float = Field(ge=0)
    revenue_eur: float = Field(ge=0)
    conversions: int = Field(ge=0)
    clicks: int = Field(ge=0)
    impressions: int = Field(ge=0)
    contribution_margin_eur: float | None = Field(default=None, ge=0)
    attribution_verified: bool = False

    @property
    def roas(self) -> float | None:
        return self.revenue_eur / self.spend_eur if self.spend_eur > 0 else None

    @property
    def ctr(self) -> float | None:
        return self.clicks / self.impressions if self.impressions > 0 else None

    @property
    def cpa_eur(self) -> float | None:
        return self.spend_eur / self.conversions if self.conversions > 0 else None


class ActionType(StrEnum):
    HOLD = "HOLD"
    PAUSE = "PAUSE_CAMPAIGN"
    INCREASE = "INCREASE_BUDGET"
    REDUCE = "REDUCE_BUDGET"
    REALLOCATE = "REALLOCATE_BUDGET"


class BudgetAction(BaseModel):
    platform: Platform
    campaign_id: str
    action: ActionType
    amount_eur: float = Field(
        ge=0,
        description="Absolute daily budget delta; for PAUSE this is the budget removed",
    )
    rationale: str = Field(min_length=4, max_length=500)
    source_platform: Platform | None = None
    source_campaign_id: str | None = None
    evidence: dict[str, float | int | str | None] = Field(default_factory=dict)


class OptimizationPlan(BaseModel):
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    interval_hours: int = Field(default=12, ge=12, le=24)
    attribution_verified: bool
    current_portfolio_daily_budget_eur: float = Field(ge=0)
    proposed_portfolio_daily_budget_eur: float = Field(ge=0)
    actions: list[BudgetAction]

    @model_validator(mode="after")
    def portfolio_total_matches_actions(self) -> "OptimizationPlan":
        increase = sum(
            a.amount_eur for a in self.actions if a.action == ActionType.INCREASE
        )
        decrease = sum(
            a.amount_eur
            for a in self.actions
            if a.action in {ActionType.REDUCE, ActionType.PAUSE}
        )
        if decrease > self.current_portfolio_daily_budget_eur + 0.02:
            raise ValueError(
                "budget reductions cannot exceed the current portfolio budget"
            )
        expected = max(
            0.0, self.current_portfolio_daily_budget_eur + increase - decrease
        )
        if not math.isclose(
            expected, self.proposed_portfolio_daily_budget_eur, abs_tol=0.02
        ):
            raise ValueError(
                "proposed portfolio budget must reconcile to the action deltas"
            )
        return self


class OptimizerPolicy(BaseModel):
    target_roas: float = Field(default=2.5, gt=0)
    min_spend_before_pause_eur: float = Field(default=20.0, ge=0)
    min_conversions_to_scale: int = Field(default=3, ge=1)
    scale_percent: float = Field(default=0.20, gt=0, le=0.30)
    max_budget_limit_eur: float = Field(default=0.0, ge=0)


def build_optimization_plan(
    metrics: list[MetricSnapshot],
    *,
    current_portfolio_daily_budget_eur: float,
    policy: OptimizerPolicy | None = None,
    interval_hours: int = 12,
) -> OptimizationPlan:
    """Turn verified ad-platform measurements into proposals; never mutates an account."""
    policy = policy or OptimizerPolicy()
    attribution_verified = bool(metrics) and all(
        m.attribution_verified and m.contribution_margin_eur is not None
        for m in metrics
    )
    actions: list[BudgetAction] = []
    if not attribution_verified:
        actions = [
            BudgetAction(
                platform=m.platform,
                campaign_id=m.campaign_id,
                action=ActionType.HOLD,
                amount_eur=0,
                rationale="Hold: purchase attribution and contribution margin are not verified.",
                evidence={"roas": m.roas, "ctr": m.ctr, "cpa_eur": m.cpa_eur},
            )
            for m in metrics
        ]
        return OptimizationPlan(
            interval_hours=interval_hours,
            attribution_verified=False,
            current_portfolio_daily_budget_eur=current_portfolio_daily_budget_eur,
            proposed_portfolio_daily_budget_eur=current_portfolio_daily_budget_eur,
            actions=actions,
        )

    underperformers = [
        m
        for m in metrics
        if m.spend_eur >= policy.min_spend_before_pause_eur
        and (m.roas is None or m.roas < policy.target_roas * 0.60)
    ]
    winners = [
        m
        for m in metrics
        if m.conversions >= policy.min_conversions_to_scale
        and (m.roas or 0) >= policy.target_roas
        and (m.contribution_margin_eur or 0) > 0
    ]
    used: set[str] = set()
    for loser, winner in zip(
        sorted(underperformers, key=lambda m: m.roas or 0),
        sorted(winners, key=lambda m: m.roas or 0, reverse=True),
    ):
        if loser.campaign_id == winner.campaign_id or loser.platform == winner.platform:
            continue
        amount = round(
            min(loser.daily_budget_eur, winner.daily_budget_eur * policy.scale_percent),
            2,
        )
        if amount <= 0:
            continue
        actions.append(
            BudgetAction(
                platform=winner.platform,
                campaign_id=winner.campaign_id,
                action=ActionType.REALLOCATE,
                amount_eur=amount,
                source_platform=loser.platform,
                source_campaign_id=loser.campaign_id,
                rationale=f"Proposed cross-channel shift from ROAS {loser.roas:.2f} to verified ROAS {winner.roas:.2f}; review attribution and margin before applying.",
                evidence={
                    "source_roas": loser.roas,
                    "target_roas": winner.roas,
                    "source_ctr": loser.ctr,
                    "target_ctr": winner.ctr,
                    "source_cpa_eur": loser.cpa_eur,
                    "target_cpa_eur": winner.cpa_eur,
                },
            )
        )
        used.update({loser.campaign_id, winner.campaign_id})
    for m in underperformers:
        if m.campaign_id not in used:
            actions.append(
                BudgetAction(
                    platform=m.platform,
                    campaign_id=m.campaign_id,
                    action=ActionType.PAUSE,
                    amount_eur=m.daily_budget_eur,
                    rationale=f"Proposed pause: spend €{m.spend_eur:.2f} with ROAS {m.roas or 0:.2f}, below the policy floor.",
                    evidence={"roas": m.roas, "ctr": m.ctr, "cpa_eur": m.cpa_eur},
                )
            )
    for m in winners:
        if m.campaign_id in used:
            continue
        amount = round(m.daily_budget_eur * policy.scale_percent, 2)
        if amount > 0:
            actions.append(
                BudgetAction(
                    platform=m.platform,
                    campaign_id=m.campaign_id,
                    action=ActionType.INCREASE,
                    amount_eur=amount,
                    rationale=f"Proposed {policy.scale_percent:.0%} scale based on verified positive margin and ROAS {m.roas:.2f}; capped for review.",
                    evidence={
                        "roas": m.roas,
                        "ctr": m.ctr,
                        "cpa_eur": m.cpa_eur,
                        "conversions": m.conversions,
                        "contribution_margin_eur": m.contribution_margin_eur,
                    },
                )
            )
    if not actions:
        actions = [
            BudgetAction(
                platform=m.platform,
                campaign_id=m.campaign_id,
                action=ActionType.HOLD,
                amount_eur=0,
                rationale="No change: sample size or performance thresholds do not justify an action.",
                evidence={"roas": m.roas, "ctr": m.ctr, "cpa_eur": m.cpa_eur},
            )
            for m in metrics
        ]
    delta = sum(a.amount_eur for a in actions if a.action == ActionType.INCREASE) - sum(
        a.amount_eur
        for a in actions
        if a.action in {ActionType.REDUCE, ActionType.PAUSE}
    )
    return OptimizationPlan(
        interval_hours=interval_hours,
        attribution_verified=True,
        current_portfolio_daily_budget_eur=current_portfolio_daily_budget_eur,
        proposed_portfolio_daily_budget_eur=round(
            current_portfolio_daily_budget_eur + delta, 2
        ),
        actions=actions,
    )


class PlatformMutationAdapter(Protocol):
    async def apply_action(self, action: BudgetAction) -> dict[str, Any]: ...


class ExecutionResult(BaseModel):
    dry_run: bool
    max_budget_limit_eur: float
    mutation_performed: bool
    blocked_reason: str | None = None
    plan: OptimizationPlan
    provider_results: list[dict[str, Any]] = Field(default_factory=list)


class PlanAuditStore:
    """Small durable local audit log; stores aggregate campaign data, never customer PII."""

    def __init__(self, database_path: Path):
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS adtech_audit (id TEXT PRIMARY KEY, kind TEXT NOT NULL, "
                "created_at TEXT NOT NULL, payload_json TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS adtech_audit_created ON adtech_audit(created_at)"
            )

    async def record(self, kind: str, payload: BaseModel | dict[str, Any]) -> str:
        serialized = (
            payload.model_dump_json()
            if isinstance(payload, BaseModel)
            else json.dumps(payload, default=str, separators=(",", ":"))
        )
        record_id = str(uuid4())
        created_at = datetime.now(timezone.utc).isoformat()

        def write() -> None:
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    "INSERT INTO adtech_audit(id,kind,created_at,payload_json) VALUES(?,?,?,?)",
                    (record_id, kind[:40], created_at, serialized),
                )
                connection.execute(
                    "DELETE FROM adtech_audit WHERE julianday(created_at) < julianday('now','-90 days')"
                )

        await asyncio.to_thread(write)
        return record_id

    async def list(self, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 200))

        def read() -> list[dict[str, Any]]:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT id,kind,created_at,payload_json FROM adtech_audit ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {
                    "id": r[0],
                    "kind": r[1],
                    "created_at": r[2],
                    "payload": json.loads(r[3]),
                }
                for r in rows
            ]

        return await asyncio.to_thread(read)


class AdExecutionEngine:
    """One fail-closed point for all ad mutations. Defaults can never spend."""

    def __init__(self, *, dry_run: bool = True, max_budget_limit: float = 0.0):
        if not math.isfinite(max_budget_limit) or max_budget_limit < 0:
            raise ValueError("max_budget_limit must be finite and cannot be negative")
        self.dry_run = dry_run
        self.max_budget_limit = float(max_budget_limit)

    async def execute(
        self,
        plan: OptimizationPlan,
        adapters: dict[Platform, PlatformMutationAdapter] | None = None,
    ) -> ExecutionResult:
        # Serialize and validate the exact candidate plan before any provider is touched.
        safe_plan = OptimizationPlan.model_validate_json(plan.model_dump_json())
        if self.dry_run:
            return ExecutionResult(
                dry_run=True,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="DRY_RUN_ENABLED",
                plan=safe_plan,
            )
        if safe_plan.proposed_portfolio_daily_budget_eur > self.max_budget_limit:
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="MAX_BUDGET_LIMIT_EXCEEDED",
                plan=safe_plan,
            )
        if safe_plan.current_portfolio_daily_budget_eur > self.max_budget_limit:
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="CURRENT_BUDGET_ABOVE_LIMIT",
                plan=safe_plan,
            )
        if not safe_plan.attribution_verified and any(
            a.action in {ActionType.INCREASE, ActionType.REALLOCATE}
            for a in safe_plan.actions
        ):
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="ATTRIBUTION_NOT_VERIFIED",
                plan=safe_plan,
            )
        if any(a.amount_eur < 0 for a in safe_plan.actions):
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="NEGATIVE_BUDGET_ACTION",
                plan=safe_plan,
            )
        if any(a.action == ActionType.REALLOCATE for a in safe_plan.actions):
            # Transfers require a two-provider saga and recovery journal; no partial move is attempted.
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="BUDGET_TRANSFER_REQUIRES_SAGA",
                plan=safe_plan,
            )
        mutating = [a for a in safe_plan.actions if a.action not in {ActionType.HOLD}]
        if len(mutating) > 1:
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="MULTI_ACTION_REQUIRES_SAGA",
                plan=safe_plan,
            )
        adapters = adapters or {}
        if any(
            a.action != ActionType.HOLD and a.platform not in adapters
            for a in safe_plan.actions
        ):
            return ExecutionResult(
                dry_run=False,
                max_budget_limit_eur=self.max_budget_limit,
                mutation_performed=False,
                blocked_reason="PLATFORM_ADAPTER_MISSING",
                plan=safe_plan,
            )
        results: list[dict[str, Any]] = []
        # Apply reductions before any increase so transient budget never exceeds the portfolio cap.
        ordered_actions = sorted(
            safe_plan.actions,
            key=lambda a: 0 if a.action in {ActionType.REDUCE, ActionType.PAUSE} else 1,
        )
        for action in ordered_actions:
            if action.action == ActionType.HOLD:
                continue
            try:
                result = await adapters[action.platform].apply_action(action)
                results.append(
                    {
                        "platform": action.platform.value,
                        "campaign_id": action.campaign_id,
                        "action": action.action.value,
                        "result": result,
                    }
                )
            except Exception:
                # Do not retry an ambiguous remote write. Record the partial state for manual reconciliation.
                return ExecutionResult(
                    dry_run=False,
                    max_budget_limit_eur=self.max_budget_limit,
                    mutation_performed=bool(results),
                    blocked_reason="PROVIDER_OUTCOME_REQUIRES_RECONCILIATION",
                    plan=safe_plan,
                    provider_results=results,
                )
        return ExecutionResult(
            dry_run=False,
            max_budget_limit_eur=self.max_budget_limit,
            mutation_performed=bool(results),
            plan=safe_plan,
            provider_results=results,
        )


class CompetitorAd(BaseModel):
    library_id: str
    page_name: str
    ad_copy: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    started_at: str | None = None
    snapshot_url: str | None = None
    intel_kind: str = "public_ad_structure_only_no_performance_data"


class MetaAdLibraryClient:
    """Official Meta Ad Library API only; deliberately no browser scraping."""

    ENDPOINT = "https://graph.facebook.com"

    def __init__(
        self,
        access_token: str,
        *,
        api_version: str = "v26.0",
        client: httpx.AsyncClient | None = None,
    ):
        if not access_token or not api_version.startswith("v"):
            raise ValueError("Meta Ad Library credentials and API version are required")
        self.access_token, self.api_version, self.client = (
            access_token,
            api_version,
            client,
        )

    async def search(
        self, terms: list[str], *, country: str = "DE", limit: int = 25
    ) -> list[CompetitorAd]:
        if country not in {"DE", "AT", "CH", "US", "GB", "FR", "IT", "ES", "NL"}:
            raise ValueError("Unsupported country code")
        bounded_terms = " ".join(" ".join(terms).split())[:200]
        if not bounded_terms or not 1 <= limit <= 50:
            raise ValueError("Search terms and a limit from 1 to 50 are required")
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5))
        own_client = self.client is None
        try:
            response = await client.get(
                f"{self.ENDPOINT}/{self.api_version}/ads_archive",
                headers={"Authorization": f"Bearer {self.access_token}"},
                params={
                    "search_terms": bounded_terms,
                    "ad_type": "ALL",
                    "ad_reached_countries": json.dumps([country]),
                    "fields": "id,page_name,ad_creative_bodies,publisher_platforms,ad_delivery_start_time,ad_snapshot_url",
                    "limit": limit,
                },
            )
            response.raise_for_status()
            rows = response.json().get("data", [])
        finally:
            if own_client:
                await client.aclose()
        return [
            CompetitorAd(
                library_id=str(x.get("id", "")),
                page_name=str(x.get("page_name", "")),
                ad_copy=[
                    str(s)[:1000] for s in (x.get("ad_creative_bodies") or [])[:4]
                ],
                platforms=[str(s) for s in (x.get("publisher_platforms") or [])[:8]],
                started_at=x.get("ad_delivery_start_time"),
                snapshot_url=x.get("ad_snapshot_url"),
            )
            for x in rows[:limit]
            if x.get("id")
        ]


async def autopilot_loop(
    *,
    load_metrics,
    build_plan,
    execution_engine: AdExecutionEngine,
    adapters: dict[Platform, PlatformMutationAdapter] | None = None,
    interval_hours: int = 12,
    stop_event: asyncio.Event | None = None,
    on_cycle=None,
) -> None:
    """Bounded 12-24h service loop. Metrics source must provide attributed, normalized data."""
    if not 12 <= interval_hours <= 24:
        raise ValueError("interval_hours must be between 12 and 24")
    stop = stop_event or asyncio.Event()
    while not stop.is_set():
        try:
            metrics, current_budget = await load_metrics()
            plan = build_plan(
                metrics,
                current_portfolio_daily_budget_eur=current_budget,
                interval_hours=interval_hours,
            )
            result = await execution_engine.execute(plan, adapters)
            if on_cycle:
                await on_cycle(plan, result)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Provider and storage errors are retried at the next bounded cycle, never in a hot loop.
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_hours * 3600)
        except TimeoutError:
            continue
