"""Performance analysis, competitor intelligence and budget-safe media execution."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field, model_validator

from .creative_factory import GeneratedCreative
from .micro_budget import (
    MetaAccountReadiness,
    MicroBudgetGate,
    configured_daily_budget_limit_eur,
    live_ads_dry_run,
    measurement_risk_accepted,
)


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
            connection.execute("CREATE INDEX IF NOT EXISTS adtech_audit_kind_created ON adtech_audit(kind,created_at)")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS meta_micro_campaign_claim ("
                "slot TEXT PRIMARY KEY, account_id TEXT NOT NULL, product_id TEXT NOT NULL, "
                "status TEXT NOT NULL, campaign_id TEXT, created_at TEXT NOT NULL)"
            )

    async def claim_meta_micro_campaign(self, account_id: str, product_id: str) -> bool:
        """Atomically burn the single-use live campaign allowance before remote writes."""
        created_at = datetime.now(timezone.utc).isoformat()

        def claim() -> bool:
            try:
                with closing(self._connect()) as connection, connection:
                    connection.execute(
                        "INSERT INTO meta_micro_campaign_claim "
                        "(slot,account_id,product_id,status,created_at) VALUES(?,?,?,?,?)",
                        ("single_live_meta_campaign", account_id, product_id, "CLAIMED", created_at),
                    )
                return True
            except sqlite3.IntegrityError:
                return False

        return await asyncio.to_thread(claim)

    async def update_meta_micro_campaign(
        self, *, status: str, campaign_id: str | None = None
    ) -> None:
        def update() -> None:
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    "UPDATE meta_micro_campaign_claim SET status=?,campaign_id=? "
                    "WHERE slot=?",
                    (status[:40], campaign_id, "single_live_meta_campaign"),
                )

        await asyncio.to_thread(update)

    async def get_meta_micro_campaign_claim(self) -> dict[str, str | None] | None:
        def read() -> dict[str, str | None] | None:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT status,campaign_id FROM meta_micro_campaign_claim WHERE slot=?",
                    ("single_live_meta_campaign",),
                ).fetchone()
            if row is None:
                return None
            return {"status": str(row[0]), "campaign_id": row[1]}

        return await asyncio.to_thread(read)

    async def release_failed_claim_without_campaign(self) -> bool:
        """Release only a known failed HTTP attempt that produced no campaign ID."""
        def delete() -> bool:
            with closing(self._connect()) as connection, connection:
                cursor = connection.execute(
                    "DELETE FROM meta_micro_campaign_claim "
                    "WHERE slot=? AND status='FAILED_HTTPStatusError' AND campaign_id IS NULL",
                    ("single_live_meta_campaign",),
                )
            return cursor.rowcount == 1

        return await asyncio.to_thread(delete)

    async def release_inactive_claim(
        self, *, campaign_id: str, expected_status: str
    ) -> bool:
        """Release the local slot only for the exact reconciled inactive campaign."""
        if expected_status not in {
            "ACTIVE_PENDING_REVIEW",
            "RECONCILED_EXISTING_CAMPAIGN",
        }:
            return False

        def delete() -> bool:
            with closing(self._connect()) as connection, connection:
                cursor = connection.execute(
                    "DELETE FROM meta_micro_campaign_claim "
                    "WHERE slot=? AND status=? AND campaign_id=?",
                    ("single_live_meta_campaign", expected_status, campaign_id),
                )
                if cursor.rowcount == 1:
                    connection.execute(
                        "INSERT INTO adtech_audit (id,kind,created_at,payload_json) VALUES(?,?,?,?)",
                        (str(uuid4()), "meta_campaign_archived", datetime.now(timezone.utc).isoformat(),
                         json.dumps({"campaign_id": campaign_id, "status": "INACTIVE",
                                     "prior_status": expected_status})),
                    )
            return cursor.rowcount == 1

        return await asyncio.to_thread(delete)

    async def has_meta_micro_campaign_claim(self) -> bool:
        return await self.get_meta_micro_campaign_claim() is not None

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

    async def latest_brain_evidence(self) -> dict[str, Any]:
        from .brain_status import KINDS

        def read():
            result = {}
            with closing(self._connect()) as connection:
                for kind in KINDS:
                    row = connection.execute(
                        "SELECT created_at,payload_json FROM adtech_audit WHERE kind=? ORDER BY created_at DESC LIMIT 1",
                        (kind,)).fetchone()
                    if row:
                        result[kind] = {"created_at": row[0], "payload": json.loads(row[1])}
                table = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pilot_brain_memory'").fetchone()
                claim = connection.execute("SELECT campaign_id FROM meta_micro_campaign_claim WHERE slot=?",
                                           ("single_live_meta_campaign",)).fetchone()
                if table and claim and claim[0]:
                    row = connection.execute("SELECT payload FROM pilot_brain_memory WHERE campaign=?", (claim[0],)).fetchone()
                    if row:
                        state = json.loads(row[0])
                        allowed = ("ad_id", "creative_id", "tracking_installed", "current_product_ids", "last_rotation_at", "inflight")
                        result["brain_memory"] = {"payload": {key: state.get(key) for key in allowed}}
            return result
        return await asyncio.to_thread(read)

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


class MetaPublisher:
    """Single-use Meta website-sales pilot with a €5/day, seven-day allowance.

    Nothing is submitted unless DRY_RUN=false, ALLOW_MICRO_BUDGET=true, the live
    account/assets pass preflight, the selected product is in the validated feed,
    the creative passes its quality checks, and the persistent one-shot claim is
    acquired. The ad set uses a €5 daily budget and a seven-day schedule.
    """

    ENDPOINT = "https://graph.facebook.com"
    DAILY_BUDGET_CENTS = 500
    API_VERSION_PATTERN = re.compile(r"^v\d+\.\d+$")
    ID_PATTERN = re.compile(r"^\d{4,30}$")
    ACCOUNT_PATTERN = re.compile(r"^act_\d{4,30}$")

    def __init__(
        self,
        audit: PlanAuditStore,
        *,
        client: httpx.AsyncClient | None = None,
        env: dict[str, str] | None = None,
    ):
        self.audit = audit
        self.client = client
        self.env = env if env is not None else os.environ

    async def reconcile_retired_campaign(self) -> dict[str, Any]:
        """Retire the owner's old campaign independently of all paid-action gates.

        Only Meta reads, idempotent child pauses and a local archive are permitted.
        An active or uncertain remote campaign always retains its local claim.
        """
        campaign_id = "120254321479480274"
        claim = await self.audit.get_meta_micro_campaign_claim()
        if claim is None or claim.get("campaign_id") != campaign_id:
            return {"status": "not_applicable", "campaign_id": campaign_id}
        status = str(claim.get("status", ""))
        if status not in {"ACTIVE_PENDING_REVIEW", "RECONCILED_EXISTING_CAMPAIGN"}:
            return {"status": "blocked", "reason": "RETIRED_CAMPAIGN_UNEXPECTED_CLAIM_STATE"}
        token = self.env.get("META_ACCESS_TOKEN", "").strip()
        if not token:
            return {"status": "blocked", "reason": "META_ACCESS_TOKEN_MISSING"}
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(timeout=35, follow_redirects=False)
        try:
            result = await self._reconcile_paused_campaign(
                client, {"Authorization": f"Bearer {token}"}, campaign_id
            )
            if result == "adsets_not_all_paused":
                # The parent is already PAUSED. Finish retiring only its children;
                # never activate or change a budget, creative, or another campaign.
                adsets = await self._get(
                    client, f"{campaign_id}/adsets", {"Authorization": f"Bearer {token}"},
                    {"fields": "id,status", "limit": "100"},
                )
                rows = adsets.get("data")
                paging = adsets.get("paging")
                if (not isinstance(rows, list)
                    or (isinstance(paging, dict) and paging.get("next"))
                    or any(not isinstance(row, dict)
                           or not self.ID_PATTERN.fullmatch(str(row.get("id", "")))
                           for row in rows)):
                    return {"status": "blocked", "reason": "adsets_incomplete"}
                for row in rows:
                    if str(row.get("status", "")).upper() == "ACTIVE":
                        response = await client.post(
                            f"{self.ENDPOINT}/{self._version()}/{row['id']}",
                            headers={"Authorization": f"Bearer {token}"},
                            data={"status": "PAUSED"},
                        )
                        self._json_response(response, require_object_id=False)
                result = await self._reconcile_paused_campaign(
                    client, {"Authorization": f"Bearer {token}"}, campaign_id
                )
            if result != "ready":
                return {"status": "blocked", "reason": result, "campaign_id": campaign_id}
            released = await self.audit.release_inactive_claim(
                campaign_id=campaign_id, expected_status=status
            )
            return {"status": "INACTIVE" if released else "claim_changed",
                    "campaign_id": campaign_id}
        finally:
            if own_client:
                await client.aclose()

    async def check_readiness(self) -> dict[str, Any]:
        """Read Meta account, Page and Pixel access without creating ad objects.

        This deliberately does not require the spend switches, DSA labels, billing
        confirmation or Purchase-event confirmation. Those are evaluated by the
        separate micro-budget gate before any campaign write.
        """
        required = {
            "META_ACCESS_TOKEN": self.env.get("META_ACCESS_TOKEN", "").strip(),
            "META_AD_ACCOUNT_ID": self.env.get("META_AD_ACCOUNT_ID", "").strip(),
            "META_PIXEL_ID": self.env.get("META_PIXEL_ID", "").strip(),
            "META_PAGE_ID": self.env.get("META_PAGE_ID", "").strip(),
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            return {"status": "blocked", "missing": missing}
        account_id = required["META_AD_ACCOUNT_ID"]
        page_id = required["META_PAGE_ID"]
        pixel_id = required["META_PIXEL_ID"]
        if not self.ACCOUNT_PATTERN.fullmatch(account_id):
            return {"status": "blocked", "reason": "META_AD_ACCOUNT_ID_INVALID"}
        if not self.ID_PATTERN.fullmatch(pixel_id) or not self.ID_PATTERN.fullmatch(page_id):
            return {"status": "blocked", "reason": "META_PIXEL_OR_PAGE_ID_INVALID"}

        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        try:
            readiness = await self._preflight(
                client,
                headers={"Authorization": f"Bearer {required['META_ACCESS_TOKEN']}"},
                account_id=account_id,
                page_id=page_id,
                pixel_id=pixel_id,
            )
            return {"status": "checked", "account": readiness.model_dump(mode="json")}
        except asyncio.CancelledError:
            raise
        except httpx.HTTPStatusError as exc:
            response = exc.response
            try:
                body = response.json()
            except ValueError:
                body = {}
            error = body.get("error", {}) if isinstance(body, dict) else {}
            if not isinstance(error, dict):
                error = {}
            tail = urlsplit(str(exc.request.url)).path.rstrip("/").rsplit("/", 1)[-1]
            stage = (
                "pixel"
                if tail == "adspixels"
                else "account"
                if tail == account_id
                else "page"
            )
            details: dict[str, Any] = {
                "status": "failed",
                "error_type": "MetaHTTPError",
                "http_status": response.status_code,
                "stage": stage,
            }
            for source, target in (
                ("code", "meta_error_code"),
                ("error_subcode", "meta_error_subcode"),
            ):
                value = error.get(source)
                if isinstance(value, int):
                    details[target] = value
            error_type = error.get("type")
            if isinstance(error_type, str):
                details["meta_error_type"] = error_type[:80]
            return details
        except Exception as exc:
            # Provider bodies and request headers may contain sensitive data.
            return {"status": "failed", "error_type": type(exc).__name__}
        finally:
            if own_client:
                await client.aclose()

    async def check_catalog_access(
        self, *, expected_product_count: int | None = None
    ) -> dict[str, Any]:
        """Read catalog and whole-catalog product-set access; never writes Meta objects."""
        token = self.env.get("META_ACCESS_TOKEN", "").strip()
        catalog_id = self.env.get("META_PRODUCT_CATALOG_ID", "").strip()
        version = self._version()
        if not token:
            return {"status": "blocked", "reason": "META_ACCESS_TOKEN_MISSING"}
        if not self.ID_PATTERN.fullmatch(catalog_id):
            return {"status": "blocked", "reason": "META_PRODUCT_CATALOG_ID_MISSING_OR_INVALID"}
        if not self.API_VERSION_PATTERN.fullmatch(version):
            return {"status": "blocked", "reason": "META_API_VERSION_INVALID"}

        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        headers = {"Authorization": f"Bearer {token}"}
        try:
            catalog = await self._get(
                client, catalog_id, headers, {"fields": "id,name"}
            )
            if str(catalog.get("id", "")) != catalog_id:
                return {"status": "blocked", "reason": "META_CATALOG_ID_MISMATCH"}

            result = await self._get(
                client,
                f"{catalog_id}/product_sets",
                headers,
                {"fields": "id,name,product_count,filter", "limit": "100"},
            )
            rows = result.get("data")
            if not isinstance(rows, list):
                return {"status": "blocked", "reason": "META_PRODUCT_SET_LIST_INVALID"}
            if isinstance(result.get("paging"), dict) and result["paging"].get("next"):
                return {"status": "blocked", "reason": "META_PRODUCT_SET_LIST_INCOMPLETE"}

            full_catalog_names = {"all products", "alle produkte"}
            full_sets = [
                row for row in rows
                if isinstance(row, dict)
                and str(row.get("name", "")).strip().casefold() in full_catalog_names
                and self.ID_PATTERN.fullmatch(str(row.get("id", "")))
            ]
            configured_set_id = self.env.get("META_PRODUCT_SET_ID", "").strip()

            def is_unfiltered_complete_set(row: dict[str, Any]) -> bool:
                filter_value = row.get("filter")
                if isinstance(filter_value, str) and filter_value.strip():
                    try:
                        filter_value = json.loads(filter_value)
                    except ValueError:
                        return False
                if filter_value not in (None, "", {}, []):
                    return False
                try:
                    item_count = int(str(row.get("product_count", "")))
                except (TypeError, ValueError):
                    return False
                return item_count > 0

            eligible_sets = [row for row in full_sets if is_unfiltered_complete_set(row)]
            if configured_set_id:
                if not self.ID_PATTERN.fullmatch(configured_set_id):
                    return {"status": "blocked", "reason": "META_PRODUCT_SET_ID_INVALID"}
                selected = [
                    row for row in eligible_sets
                    if str(row.get("id")) == configured_set_id
                ]
                if len(selected) != 1:
                    return {
                        "status": "blocked",
                        "reason": "META_CONFIGURED_SET_IS_NOT_VERIFIED_ALL_PRODUCTS",
                        "catalog_id": catalog_id,
                        "matching_set_count": len(full_sets),
                        "eligible_unfiltered_set_count": len(eligible_sets),
                    }
                full_set = selected[0]
            elif len(eligible_sets) == 1:
                full_set = eligible_sets[0]
            elif len(eligible_sets) > 1:
                # Same label, empty filters, and exact feed count prove equivalent
                # full-catalog scopes; stable numeric ordering makes retries idempotent.
                full_set = sorted(eligible_sets, key=lambda row: int(str(row["id"])))[0]
            else:
                return {
                    "status": "blocked",
                    "reason": "META_ALL_PRODUCTS_SET_NOT_FOUND_OR_AMBIGUOUS",
                    "catalog_id": catalog_id,
                    "matching_set_count": len(full_sets),
                    "eligible_unfiltered_set_count": 0,
                    "expected_product_count": expected_product_count,
                    "candidate_sets": [{
                        "id": str(row.get("id", "")),
                        "product_count": row.get("product_count"),
                        "filter_type": type(row.get("filter")).__name__,
                        "filter_empty": row.get("filter") in (None, "", {}, []),
                    } for row in full_sets],
                }

            return {
                "status": "checked",
                "catalog_id": catalog_id,
                "catalog_name": str(catalog.get("name", ""))[:160],
                "product_set_id": str(full_set["id"]),
                "product_set_name": str(full_set.get("name", ""))[:80],
                "product_count": int(str(full_set.get("product_count", "0"))),
                "selection_basis": "unfiltered_exact_feed_count" if expected_product_count is not None else "unique_unfiltered_all_products_set",
                "visible_product_set_count": len(rows),
                "campaign_writes_performed": False,
            }
        except asyncio.CancelledError:
            raise
        except httpx.HTTPStatusError as exc:
            try:
                body = exc.response.json()
            except ValueError:
                body = {}
            error = body.get("error", {}) if isinstance(body, dict) else {}
            if not isinstance(error, dict):
                error = {}
            details: dict[str, Any] = {
                "status": "failed",
                "reason": "META_CATALOG_READ_FAILED",
                "http_status": exc.response.status_code,
                "campaign_writes_performed": False,
            }
            for source, target in (
                ("code", "meta_error_code"),
                ("error_subcode", "meta_error_subcode"),
            ):
                value = error.get(source)
                if isinstance(value, int):
                    details[target] = value
            if isinstance(error.get("type"), str):
                details["meta_error_type"] = error["type"][:80]
            return details
        except Exception as exc:
            # Never include provider response bodies, headers, or credentials in logs.
            return {
                "status": "failed",
                "reason": "META_CATALOG_READ_FAILED",
                "error_type": type(exc).__name__,
                "campaign_writes_performed": False,
            }
        finally:
            if own_client:
                await client.aclose()

    async def publish_existing_catalog_campaign(
        self,
        *,
        campaign_id: str,
        feed_record_count: int,
    ) -> dict[str, Any]:
        """Convert the exact owned, paused campaign's ad to the verified All products set.

        This is an idempotent in-place creative migration: it never creates a campaign,
        ad set, or extra ad, and it deliberately leaves every delivery object PAUSED.
        """
        campaign_id = str(campaign_id).strip()
        account_id = self.env.get("META_AD_ACCOUNT_ID", "").strip()
        token = self.env.get("META_ACCESS_TOKEN", "").strip()
        page_id = self.env.get("META_PAGE_ID", "").strip()
        pixel_id = self.env.get("META_PIXEL_ID", "").strip()
        version = self._version()
        if not self.ID_PATTERN.fullmatch(campaign_id):
            return {"status": "blocked", "reason": "CATALOG_CAMPAIGN_ID_INVALID"}
        if not self.ACCOUNT_PATTERN.fullmatch(account_id):
            return {"status": "blocked", "reason": "META_AD_ACCOUNT_ID_INVALID"}
        if not token or not self.ID_PATTERN.fullmatch(page_id) or not self.ID_PATTERN.fullmatch(pixel_id):
            return {"status": "blocked", "reason": "META_CATALOG_CONFIGURATION_INCOMPLETE"}
        if not self.API_VERSION_PATTERN.fullmatch(version):
            return {"status": "blocked", "reason": "META_API_VERSION_INVALID"}

        claim = await self.audit.get_meta_micro_campaign_claim()
        if (
            not isinstance(claim, dict)
            or str(claim.get("campaign_id", "")) != campaign_id
            or claim.get("status") not in {"ACTIVE_PENDING_REVIEW", "RECONCILED_EXISTING_CAMPAIGN"}
        ):
            return {"status": "blocked", "reason": "EXACT_OWNED_CAMPAIGN_SCOPE_REQUIRED",
                    "campaign_id": campaign_id}
        # A stale local account label is not authority to mutate anything. The
        # remote campaign/account relationship is verified below before writes.
        stored_claim_account_matches = (
            str(claim.get("account_id", "")).removeprefix("act_")
            == account_id.removeprefix("act_")
        )

        catalog = await self.check_catalog_access(expected_product_count=feed_record_count)
        if catalog.get("status") != "checked":
            return {"status": "blocked", "reason": catalog.get("reason", "META_ALL_PRODUCTS_SET_NOT_VERIFIED"),
                    "catalog_check": catalog}

        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(35, connect=8), follow_redirects=False
        )
        headers = {"Authorization": f"Bearer {token}"}
        writes_performed = False
        stage = "account_read"
        try:
            account = await self._get(
                client, account_id, headers,
                {"fields": "id,currency,spend_cap,amount_spent"},
            )
            if (
                str(account.get("id", "")).removeprefix("act_")
                    != account_id.removeprefix("act_")
                or str(account.get("currency", "")).upper() != "EUR"
                or int(str(account.get("spend_cap", ""))) != 3500
                or int(str(account.get("amount_spent", "0"))) > 3500
            ):
                return {"status": "blocked", "reason": "GLOBAL_35_EUR_ACCOUNT_CAP_READBACK_FAILED",
                        "campaign_id": campaign_id}

            stage = "campaign_read"
            campaign = await self._get(
                client, campaign_id, headers,
                {"fields": "id,account_id,objective,status"},
            )
            if (
                str(campaign.get("id", "")) != campaign_id
                or str(campaign.get("account_id", "")).removeprefix("act_")
                    != account_id.removeprefix("act_")
                or campaign.get("objective") != "OUTCOME_SALES"
                or str(campaign.get("status", "")).upper() != "PAUSED"
            ):
                return {"status": "blocked", "reason": "OWNED_PAUSED_CAMPAIGN_READBACK_FAILED",
                        "campaign_id": campaign_id}

            stage = "adsets_read"
            adsets_result = await self._get(
                client, f"{campaign_id}/adsets", headers,
                {"fields": "id,status,daily_budget,targeting,start_time,end_time", "limit": "100"},
            )
            adsets = adsets_result.get("data")
            if (
                not isinstance(adsets, list) or len(adsets) != 1
                or (isinstance(adsets_result.get("paging"), dict) and adsets_result["paging"].get("next"))
            ):
                return {"status": "blocked", "reason": "EXISTING_SINGLE_ADSET_REQUIRED",
                        "campaign_id": campaign_id}
            adset = adsets[0]
            adset_id = str(adset.get("id", ""))
            targeting = adset.get("targeting") or {}
            geo = targeting.get("geo_locations") or {}
            countries = set(geo.get("countries") or [])
            if (
                not self.ID_PATTERN.fullmatch(adset_id)
                or str(adset.get("status", "")).upper() not in {"PAUSED", "ACTIVE"}
                or str(adset.get("daily_budget", "")) != "500"
                or not {"DE", "AT"}.issubset(countries)
            ):
                return {"status": "blocked", "reason": "EXISTING_ADSET_LIMITS_NOT_VERIFIED",
                        "campaign_id": campaign_id, "adset_id": adset_id or None}

            if targeting.get("publisher_platforms") != ["facebook"]:
                facebook_targeting = dict(targeting)
                facebook_targeting["publisher_platforms"] = ["facebook"]
                facebook_targeting.pop("instagram_positions", None)
                facebook_targeting.pop("messenger_positions", None)
                facebook_targeting.pop("audience_network_positions", None)
                stage = "facebook_only_placement_update"
                placement_response = await client.post(
                    f"{self.ENDPOINT}/{version}/{adset_id}",
                    headers=headers,
                    data={"targeting": json.dumps(facebook_targeting), "status": "PAUSED"},
                )
                self._json_response(placement_response, require_object_id=False)
                stage = "facebook_only_placement_readback"
                adset_readback = await self._get(
                    client, adset_id, headers,
                    {"fields": "id,status,daily_budget,targeting"},
                )
                readback_targeting = adset_readback.get("targeting") or {}
                if (
                    str(adset_readback.get("id", "")) != adset_id
                    or str(adset_readback.get("status", "")).upper() != "PAUSED"
                    or str(adset_readback.get("daily_budget", "")) != "500"
                    or readback_targeting.get("publisher_platforms") != ["facebook"]
                ):
                    return {"status": "write_unconfirmed", "reason": "FACEBOOK_ONLY_PLACEMENTS_NOT_CONFIRMED",
                            "campaign_id": campaign_id, "adset_id": adset_id,
                            "writes_performed": True, "activation_performed": False}
                targeting = readback_targeting
            stage = "ads_read"
            ads_result = await self._get(
                client, f"{adset_id}/ads", headers,
                {"fields": "id,campaign_id,adset_id,status,creative", "limit": "100"},
            )
            ads = ads_result.get("data")
            if (
                not isinstance(ads, list)
                or (isinstance(ads_result.get("paging"), dict) and ads_result["paging"].get("next"))
            ):
                return {"status": "blocked", "reason": "EXISTING_ADS_READ_INCOMPLETE",
                        "campaign_id": campaign_id, "adset_id": adset_id}
            ad_id = ""
            actual_creative_id = ""
            matching_catalog_ad_id = ""
            matching_catalog_creative_id = ""
            for existing_ad in ads:
                existing_ad_id = str(existing_ad.get("id", ""))
                existing_creative_id = str((existing_ad.get("creative") or {}).get("id", ""))
                if (
                    not self.ID_PATTERN.fullmatch(existing_ad_id)
                    or str(existing_ad.get("campaign_id", "")) != campaign_id
                    or str(existing_ad.get("adset_id", "")) != adset_id
                    or str(existing_ad.get("status", "")).upper() != "PAUSED"
                    or not self.ID_PATTERN.fullmatch(existing_creative_id)
                ):
                    return {"status": "blocked", "reason": "EXISTING_PAUSED_AD_READBACK_FAILED",
                            "campaign_id": campaign_id, "adset_id": adset_id}
                stage = "existing_creative_read"
                existing_creative = await self._get(
                    client, existing_creative_id, headers,
                    {"fields": "id,product_set_id,object_story_spec"},
                )
                existing_story = existing_creative.get("object_story_spec") or {}
                existing_template = existing_story.get("template_data")
                if (
                    str(existing_creative.get("product_set_id", "")) == str(catalog["product_set_id"])
                    and isinstance(existing_template, dict)
                ):
                    if matching_catalog_ad_id:
                        return {"status": "blocked", "reason": "MULTIPLE_ADS_MATCH_CATALOG_PRODUCT_SET",
                                "campaign_id": campaign_id, "adset_id": adset_id}
                    matching_catalog_ad_id = existing_ad_id
                    matching_catalog_creative_id = existing_creative_id
                    ad_id = existing_ad_id
                    actual_creative_id = existing_creative_id
                    name_mapped = "{{product.name}}" in str(existing_template.get("name", ""))
                    description_mapped = "{{product.description}}" in str(existing_template.get("description", ""))
                    if not (name_mapped and description_mapped):
                        continue
                    return {
                        "status": "catalog_verified",
                        "campaign_id": campaign_id,
                        "adset_id": adset_id,
                        "ad_id": existing_ad_id,
                        "creative_id": existing_creative_id,
                        "product_catalog_id": catalog["catalog_id"],
                        "product_set_id": catalog["product_set_id"],
                        "product_set_name": catalog["product_set_name"],
                        "shopify_feed_records": feed_record_count,
                        "campaign_status": "PAUSED",
                        "stored_claim_account_matches": stored_claim_account_matches,
                        "daily_budget_eur": "5.00",
                        "account_spend_cap_eur": "35.00",
                        "writes_performed": False,
                        "activation_performed": False,
                    }

            if not matching_catalog_ad_id:
                return {"status": "blocked", "reason": "EXISTING_CATALOG_AD_IDENTITY_NOT_FOUND",
                        "campaign_id": campaign_id, "adset_id": adset_id}
            # AdCreative content is immutable in Meta. Create a catalog creative,
            # then attach its ID to the existing paused ad; do not send an inline
            # creative spec in the Ad.update call.
            stage = "catalog_ad_creative_create"
            writes_performed = True
            creative_response = await client.post(
                f"{self.ENDPOINT}/{version}/{account_id}/adcreatives",
                headers=headers,
                data={
                    "name": f"Homestro catalog creative // {campaign_id}"[:240],
                    "product_set_id": str(catalog["product_set_id"]),
                    "object_story_spec": json.dumps({
                        "page_id": page_id,
                        "template_data": {
                            "message": "Entdecke Produkte von Homestro für deinen Alltag.",
                            "name": "{{product.name}}",
                            "description": "Produktdetails: {{product.description}}",
                            "link": "https://homestro.de",
                            "call_to_action": {"type": "SHOP_NOW"},
                        },
                    }, ensure_ascii=False),
                },
            )
            creative_payload = self._json_response(creative_response)
            new_creative_id = str(creative_payload.get("id", ""))
            if not self.ID_PATTERN.fullmatch(new_creative_id):
                return {"status": "write_unconfirmed", "reason": "META_CATALOG_CREATIVE_ID_MISSING",
                        "campaign_id": campaign_id, "adset_id": adset_id, "ad_id": ad_id,
                        "writes_performed": True, "activation_performed": False}

            stage = "catalog_ad_creative_attach"
            attach_response = await client.post(
                f"{self.ENDPOINT}/{version}/{ad_id}",
                headers=headers,
                data={
                    "creative": json.dumps({"creative_id": new_creative_id}),
                    "status": "PAUSED",
                },
            )
            self._json_response(attach_response, require_object_id=False)
            stage = "catalog_ad_readback"
            ad_readback = await self._get(
                client, ad_id, headers,
                {"fields": "id,campaign_id,adset_id,status,effective_status,creative"},
            )
            actual_creative_id = str((ad_readback.get("creative") or {}).get("id", ""))
            stage = "catalog_creative_readback"
            creative_readback = await self._get(
                client, actual_creative_id, headers,
                {"fields": "id,product_set_id,object_story_spec"},
            )
            readback_story = creative_readback.get("object_story_spec") or {}
            readback_template = readback_story.get("template_data")
            mismatch_fields = []
            if str(ad_readback.get("id", "")) != ad_id:
                mismatch_fields.append("ad_id")
            if str(ad_readback.get("campaign_id", "")) != campaign_id:
                mismatch_fields.append("campaign_id")
            if str(ad_readback.get("adset_id", "")) != adset_id:
                mismatch_fields.append("adset_id")
            if str(ad_readback.get("status", "")).upper() != "PAUSED":
                mismatch_fields.append("ad_status")
            if actual_creative_id != new_creative_id:
                mismatch_fields.append("creative_id")
            if str(creative_readback.get("product_set_id", "")) != str(catalog["product_set_id"]):
                mismatch_fields.append("product_set_id")
            if str(readback_story.get("page_id", "")) != page_id:
                mismatch_fields.append("page_id")
            if not isinstance(readback_template, dict):
                mismatch_fields.extend(["template_data.name", "template_data.description"])
            else:
                if "{{product.name}}" not in str(readback_template.get("name", "")):
                    mismatch_fields.append("template_data.name")
                if "{{product.description}}" not in str(readback_template.get("description", "")):
                    mismatch_fields.append("template_data.description")
            if mismatch_fields:
                return {"status": "write_unconfirmed", "reason": "CATALOG_CREATIVE_READBACK_MISMATCH",
                        "campaign_id": campaign_id, "adset_id": adset_id, "ad_id": ad_id,
                        "creative_id": actual_creative_id or None,
                        "mismatch_fields": mismatch_fields,
                        "writes_performed": True, "activation_performed": False}

            await self.audit.record("meta_catalog_campaign_migrated", {
                "campaign_id": campaign_id, "adset_id": adset_id, "ad_id": ad_id,
                "creative_id": actual_creative_id, "product_catalog_id": catalog["catalog_id"],
                "product_set_id": catalog["product_set_id"], "product_set_name": catalog["product_set_name"],
                "shopify_feed_records": feed_record_count, "daily_budget_eur": "5.00",
                "account_spend_cap_eur": "35.00", "status": "PAUSED",
            })
            return {
                "status": "catalog_updated_paused",
                "campaign_id": campaign_id,
                "adset_id": adset_id,
                "ad_id": ad_id,
                "creative_id": actual_creative_id,
                "product_catalog_id": catalog["catalog_id"],
                "product_set_id": catalog["product_set_id"],
                "product_set_name": catalog["product_set_name"],
                "shopify_feed_records": feed_record_count,
                "campaign_status": "PAUSED",
                "stored_claim_account_matches": stored_claim_account_matches,
                "daily_budget_eur": "5.00",
                "account_spend_cap_eur": "35.00",
                "writes_performed": True,
                "activation_performed": False,
            }
        except asyncio.CancelledError:
            raise
        except httpx.HTTPStatusError as exc:
            response = exc.response
            try:
                body = response.json()
            except ValueError:
                body = {}
            error = body.get("error", {}) if isinstance(body, dict) else {}
            if not isinstance(error, dict):
                error = {}
            result = {
                "status": "blocked",
                "reason": "META_CATALOG_UPDATE_FAILED",
                "campaign_id": campaign_id,
                "stage": stage,
                "http_status": response.status_code,
                "writes_performed": writes_performed,
                "activation_performed": False,
            }
            if isinstance(error.get("code"), int):
                result["meta_error_code"] = error["code"]
            if isinstance(error.get("error_subcode"), int):
                result["meta_error_subcode"] = error["error_subcode"]
            if isinstance(error.get("type"), str):
                result["meta_error_type"] = error["type"][:80]
            if isinstance(error.get("message"), str):
                result["meta_error_message"] = error["message"][:240]
            if isinstance(error.get("error_user_title"), str):
                result["meta_error_user_title"] = error["error_user_title"][:160]
            if isinstance(error.get("error_user_msg"), str):
                result["meta_error_user_msg"] = error["error_user_msg"][:240]
            return result
        except Exception as exc:
            return {
                "status": "blocked",
                "reason": type(exc).__name__,
                "campaign_id": campaign_id,
                "writes_performed": writes_performed,
                "activation_performed": False,
            }
        finally:
            if own_client:
                await client.aclose()

    async def publish_one(
        self,
        *,
        creative: GeneratedCreative | None,
        product: dict[str, Any],
        product_ids_in_feed: set[str],
        products: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        config = self._configuration()
        if isinstance(config, dict):
            return {"status": "blocked", **config}
        from .purchase_guard import PurchaseEvidence, requires_recent_purchase

        evidence = await PurchaseEvidence(env=self.env, client=self.client).check()
        if requires_recent_purchase(self.env) and not evidence["verified"]:
            return {"status": "blocked", "reason": "FRESH_PURCHASE_REQUIRED", "purchase": evidence}
        account_id, page_id, pixel_id, token, version, beneficiary, payor, catalog_id, product_set_id = config
        website_mode = self.env.get("PILOT_AD_MODE", "catalog") == "website_sales"
        story = None
        advertised_ids: list[str] = []
        if website_mode:
            from .website_ads import website_story

            try:
                story, advertised_ids = website_story(products or [product], page_id)
            except ValueError as exc:
                return {"status": "blocked", "reason": str(exc)}
            if not set(advertised_ids).issubset(product_ids_in_feed):
                return {"status": "blocked", "reason": "PRODUCT_NOT_IN_VALIDATED_FEED"}
        product_id = str(product.get("id", ""))
        # Catalog items supply their own images and destination URLs.
        link = str(product.get("link", ""))
        parsed_link = urlsplit(link)
        if (
            parsed_link.scheme != "https"
            or parsed_link.hostname not in {"homestro.de", "www.homestro.de"}
            or parsed_link.username
            or parsed_link.password
        ):
            return {"status": "blocked", "reason": "PRODUCT_URL_NOT_ALLOWED"}
        if product_id not in product_ids_in_feed:
            return {"status": "blocked", "reason": "PRODUCT_NOT_IN_VALIDATED_FEED"}
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(35, connect=8), follow_redirects=False
        )
        headers = {"Authorization": f"Bearer {token}"}
        created_ids: dict[str, str] = {}
        claim_acquired = False
        resumed_campaign: str | None = None
        try:
            if not website_mode and not product_set_id:
                resolved_set_id = await self._resolve_all_products_set(
                    client, catalog_id, headers
                )
                if not resolved_set_id:
                    return {
                        "status": "blocked",
                        "reason": "META_ALL_PRODUCTS_SET_NOT_FOUND_OR_AMBIGUOUS",
                        "product_catalog_id": catalog_id,
                    }
                product_set_id = resolved_set_id
            prior_claim = await self.audit.get_meta_micro_campaign_claim()
            if prior_claim is not None:
                if (
                    prior_claim["status"] == "FAILED_HTTPStatusError"
                    and prior_claim["campaign_id"] is None
                ):
                    reconciliation = await self._reconcile_failed_claim(
                        client, account_id, headers, product_id
                    )
                    if reconciliation == "not_found":
                        released = await self.audit.release_failed_claim_without_campaign()
                        if not released:
                            return {"status": "blocked", "reason": "ONE_CAMPAIGN_ALLOWANCE_ALREADY_CLAIMED"}
                        await self.audit.record(
                            "meta_micro_campaign_claim_released",
                            {"reason": "Meta confirmed no campaign exists", "product_id": product_id},
                        )
                    else:
                        return {
                            "status": "blocked",
                            "reason": (
                                "PRIOR_META_CAMPAIGN_FOUND"
                                if reconciliation == "found"
                                else "PRIOR_CAMPAIGN_RECONCILIATION_INCOMPLETE"
                            ),
                        }
                elif (
                    prior_claim["status"] == "FAILED_HTTPStatusError"
                    and prior_claim["campaign_id"] is not None
                ):
                    resumed_campaign = str(prior_claim["campaign_id"])
                    reconciliation = await self._reconcile_paused_campaign(
                        client, headers, resumed_campaign
                    )
                    if reconciliation != "ready":
                        return {
                            "status": "blocked",
                            "reason": "PRIOR_CAMPAIGN_NOT_SAFE_TO_RESUME",
                            "campaign_id": resumed_campaign,
                            "reconciliation": reconciliation,
                        }
                elif (
                    prior_claim["campaign_id"]
                    and prior_claim["status"]
                    in {"ACTIVE_PENDING_REVIEW", "RECONCILED_EXISTING_CAMPAIGN"}
                ):
                    # Keep identity through watchdog pauses; never recreate it.
                    return {"status": "existing_campaign", "campaign_id": prior_claim["campaign_id"],
                            "reason": "EXISTING_CAMPAIGN_RETAINED_NO_DUPLICATE"}
                else:
                    return {
                        "status": "blocked",
                        "reason": "ONE_CAMPAIGN_ALLOWANCE_ALREADY_CLAIMED",
                        "campaign_id": prior_claim["campaign_id"],
                        "claim_status": prior_claim["status"],
                    }

            readiness = await self._preflight(
                client,
                headers=headers,
                account_id=account_id,
                page_id=page_id,
                pixel_id=pixel_id,
            )
            gate = MicroBudgetGate(enabled=True).evaluate(
                account=readiness,
                purchase_event_verified=self.env.get("META_PURCHASE_EVENT_VERIFIED", "false").lower() == "true",
                unverified_measurement_test_authorized=measurement_risk_accepted(self.env),
                product_ids_in_feed=product_ids_in_feed,
                previously_submitted_campaigns=0,
                dry_run=False,
            )
            if not gate.eligible:
                return {"status": "blocked", "reason": "MICRO_BUDGET_PREFLIGHT_FAILED", "blockers": gate.blockers}
            claim_acquired = True
            if resumed_campaign is None:
                if not await self.audit.claim_meta_micro_campaign(account_id, product_id):
                    return {"status": "blocked", "reason": "ONE_CAMPAIGN_ALLOWANCE_ALREADY_CLAIMED"}
                await self.audit.record(
                    "meta_micro_budget_claim",
                    {
                        "account_id": account_id,
                        "product_id": product_id,
                        "daily_budget_eur": MicroBudgetGate.DAILY_BUDGET_EUR,
                        "lifetime_budget_eur": 0.0,
                        "planned_days": MicroBudgetGate.PLANNED_DAYS,
                        "planned_total_eur": MicroBudgetGate.TOTAL_BUDGET_EUR,
                    },
                )
                campaign = await self._post(
                    client,
                    f"{account_id}/campaigns",
                    headers,
                    {
                        "name": self._campaign_name(),
                        "objective": "OUTCOME_SALES",
                        "status": "PAUSED",
                        "special_ad_categories": "[]",
                        "is_adset_budget_sharing_enabled": "False",
                    },
                )
            else:
                campaign = resumed_campaign
                await self.audit.record(
                    "meta_micro_campaign_resume",
                    {"campaign_id": campaign, "product_id": product_id, "status": "paused"},
                )
            created_ids["campaign_id"] = campaign
            await self.audit.update_meta_micro_campaign(status="CAMPAIGN_CREATED_PAUSED", campaign_id=campaign)

            from datetime import timedelta

            starts = datetime.now(timezone.utc) + timedelta(minutes=15)
            ends = starts + timedelta(days=MicroBudgetGate.PLANNED_DAYS)
            existing_adsets = await self._get(
                client,
                f"{campaign}/adsets",
                headers,
                {"fields": "id,name,status,daily_budget,lifetime_budget", "limit": "100"},
            )
            existing_rows = existing_adsets.get("data")
            if not isinstance(existing_rows, list):
                return {"status": "blocked", "reason": "ADSET_RECONCILIATION_INCOMPLETE", "campaign_id": campaign}
            if isinstance(existing_adsets.get("paging"), dict) and existing_adsets["paging"].get("next"):
                return {"status": "blocked", "reason": "ADSET_RECONCILIATION_INCOMPLETE", "campaign_id": campaign}
            daily_adsets = [
                row for row in existing_rows
                if isinstance(row, dict) and str(row.get("daily_budget", "")) == str(self.DAILY_BUDGET_CENTS)
            ]
            if len(daily_adsets) > 1:
                return {"status": "blocked", "reason": "MULTIPLE_DAILY_ADSETS_FOUND", "campaign_id": campaign}
            if daily_adsets:
                existing = daily_adsets[0]
                if str(existing.get("status", "")).upper() != "PAUSED" or not existing.get("id"):
                    return {"status": "blocked", "reason": "DAILY_ADSET_NOT_SAFE_TO_RESUME", "campaign_id": campaign}
                existing_ads = await self._get(
                    client, f"{existing['id']}/ads", headers,
                    {"fields": "id,status", "limit": "100"},
                )
                ads = existing_ads.get("data")
                if not isinstance(ads, list) or ads or (isinstance(existing_ads.get("paging"), dict) and existing_ads["paging"].get("next")):
                    return {"status": "blocked", "reason": "DAILY_ADSET_ALREADY_HAS_ADS_OR_INCOMPLETE", "campaign_id": campaign, "adset_id": str(existing["id"])}
                adset = str(existing["id"])
                await self.audit.record("meta_micro_adset_resume", {"campaign_id": campaign, "adset_id": adset})
            else:
                adset = await self._post(
                    client,
                    f"{account_id}/adsets",
                    headers,
                    {
                        "name": "Homestro DE AT Website Sales" if website_mode else "Homestro DE Catalog All Products",
                        "campaign_id": campaign,
                        "daily_budget": str(self.DAILY_BUDGET_CENTS),
                    "billing_event": "IMPRESSIONS",
                    "optimization_goal": "OFFSITE_CONVERSIONS",
                    "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                    "destination_type": "WEBSITE",
                    "promoted_object": json.dumps(
                        {"pixel_id": pixel_id, "custom_event_type": "PURCHASE",
                         **({} if website_mode else {"product_catalog_id": catalog_id})}
                    ),
                    "dsa_beneficiary": beneficiary,
                    "dsa_payor": payor,
                    "targeting": json.dumps(
                        {
                            "geo_locations": {"countries": ["DE", "AT"]},
                            "age_min": 18,
                            "publisher_platforms": ["facebook", "instagram"],
                            "facebook_positions": ["feed", "marketplace", "story", "facebook_reels"],
                            "instagram_positions": ["stream", "story", "reels"],
                        }
                    ),
                    "start_time": starts.isoformat(),
                    "end_time": ends.isoformat(),
                    "status": "PAUSED",
                    },
                )
            created_ids["adset_id"] = adset
            await self.audit.record("meta_micro_campaign_partial", {"campaign_id": campaign, "adset_id": adset})
            adcreative = await self._post(
                client,
                f"{account_id}/adcreatives",
                headers,
                ({"name": "Homestro Website Creative", "object_story_spec": json.dumps(story, ensure_ascii=False)}
                 if website_mode else {
                    "name": "Homestro Catalog Creative",
                    "product_set_id": product_set_id,
                    "object_story_spec": json.dumps(
                        {
                            "page_id": page_id,
                            "template_data": {
                                "message": "Entdecke Produkte von Homestro für deinen Alltag.",
                                "name": "{{product.name}}",
                                "description": "{{product.description}}",
                                "link": "https://homestro.de",
                                "call_to_action": {"type": "SHOP_NOW"},
                            },
                        }
                    ),
                }),
            )
            ad = await self._post(
                client,
                f"{account_id}/ads",
                headers,
                {
                    "name": "Homestro Website Products" if website_mode else "Homestro Catalog Ad All Products",
                    "adset_id": adset,
                    "creative": json.dumps({"creative_id": adcreative}),
                    "status": "PAUSED",
                },
            )
            created_ids.update({"adcreative_id": adcreative, "ad_id": ad})
            await self.audit.record("meta_micro_campaign_partial", created_ids)

            # Activate children while the campaign is still paused, then open the
            # campaign last. On an ambiguous failure all known objects are paused.
            await self._activate(client, adset, headers)
            await self._activate(client, ad, headers)
            await self._activate(client, campaign, headers)
            await self.audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id=campaign)
            result = {
                "status": "ACTIVE_PENDING_REVIEW",
                "platform": "meta",
                "campaign_id": campaign,
                "adset_id": adset,
                "ad_id": ad,
                "product_scope": "shopify_website_carousel" if website_mode else "entire_meta_catalog",
                "advertised_product_ids": advertised_ids,
                "product_catalog_id": catalog_id,
                "product_set_id": product_set_id,
                "budget_type": "daily",
                "daily_budget_eur": MicroBudgetGate.DAILY_BUDGET_EUR,
                "lifetime_budget_eur": 0.0,
                "planned_total_eur": MicroBudgetGate.TOTAL_BUDGET_EUR,
                "scheduled_window_days": MicroBudgetGate.PLANNED_DAYS,
                "dry_run": False,
                "note": "Meta review must approve the ad; a campaign does not guarantee impressions or sales.",
            }
            await self.audit.record("meta_micro_campaign_result", result)
            return result
        except asyncio.CancelledError:
            await self._pause_created(client, created_ids, headers)
            await self.audit.update_meta_micro_campaign(status="CANCELLED_PAUSED", campaign_id=created_ids.get("campaign_id"))
            raise
        except Exception as exc:
            await self._pause_created(client, created_ids, headers)
            await self.audit.update_meta_micro_campaign(status=f"FAILED_{type(exc).__name__}", campaign_id=created_ids.get("campaign_id"))
            # Keep provider details bounded and non-secret so a failure can be diagnosed.
            details: dict[str, Any] = {
                "status": "failed_closed",
                "error_type": type(exc).__name__,
                "created_objects_paused": bool(created_ids),
                "one_campaign_allowance_consumed": claim_acquired,
            }
            if isinstance(exc, httpx.HTTPStatusError):
                response = exc.response
                try:
                    body = response.json()
                except ValueError:
                    body = {}
                error = body.get("error", {}) if isinstance(body, dict) else {}
                if not isinstance(error, dict):
                    error = {}
                tail = urlsplit(str(exc.request.url)).path.rstrip("/").rsplit("/", 1)[-1]
                details["error_type"] = "MetaHTTPError"
                details["http_status"] = response.status_code
                details["stage"] = {
                    "campaigns": "campaign_create",
                    "adsets": "adset_create",
                    "adimages": "image_upload",
                    "adcreatives": "creative_create",
                    "ads": "ad_create",
                }.get(tail, "preflight_or_activation")
                for source, target in (
                    ("code", "meta_error_code"),
                    ("error_subcode", "meta_error_subcode"),
                ):
                    value = error.get(source)
                    if isinstance(value, int):
                        details[target] = value
                error_type = error.get("type")
                if isinstance(error_type, str):
                    details["meta_error_type"] = error_type[:80]
                for source, target in (
                    ("error_user_title", "meta_error_title"),
                    ("error_user_msg", "meta_error_message"),
                    ("message", "meta_error_summary"),
                ):
                    value = error.get(source)
                    if isinstance(value, str):
                        details[target] = " ".join(value.split())[:240]
            return details
        finally:
            if own_client:
                await client.aclose()

    async def _reconcile_paused_campaign(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        campaign_id: str,
    ) -> str:
        """Resume only a confirmed paused campaign with no active ad sets."""
        campaign = await self._get(
            client, campaign_id, headers, {"fields": "id,status"}
        )
        if str(campaign.get("id", "")) != campaign_id:
            return "campaign_mismatch"
        if str(campaign.get("status", "")).upper() != "PAUSED":
            return "campaign_not_paused"
        adsets = await self._get(
            client,
            f"{campaign_id}/adsets",
            headers,
            {"fields": "id,name,status,daily_budget,lifetime_budget", "limit": "100"},
        )
        rows = adsets.get("data")
        if not isinstance(rows, list):
            return "adsets_incomplete"
        if any(str(row.get("status", "")).upper() != "PAUSED" for row in rows if isinstance(row, dict)):
            return "adsets_not_all_paused"
        if any(not isinstance(row, dict) for row in rows):
            return "adsets_incomplete"
        paging = adsets.get("paging")
        if isinstance(paging, dict) and paging.get("next"):
            return "adsets_incomplete"
        return "ready"

    async def _reconcile_failed_claim(
        self,
        client: httpx.AsyncClient,
        account_id: str,
        headers: dict[str, str],
        product_id: str,
    ) -> str:
        """Read Meta's campaign list before releasing an ambiguous local claim."""
        result = await self._get(
            client,
            f"{account_id}/campaigns",
            headers,
            {"fields": "id,name,status", "limit": "100"},
        )
        rows = result.get("data")
        if not isinstance(rows, list):
            return "incomplete"
        expected_name = self._campaign_name()
        for row in rows:
            if not isinstance(row, dict) or row.get("name") != expected_name:
                continue
            campaign_id = str(row.get("id", ""))
            if not campaign_id:
                return "incomplete"
            await self.audit.update_meta_micro_campaign(
                status="RECONCILED_EXISTING_CAMPAIGN", campaign_id=campaign_id
            )
            return "found"
        paging = result.get("paging")
        if isinstance(paging, dict) and paging.get("next"):
            return "incomplete"
        return "not_found"

    def _configuration(
        self,
    ) -> tuple[str, str, str, str, str, str, str, str, str] | dict[str, Any]:
        if self.env.get('PILOT_LAUNCH_POLICY') == 'first_purchase_acquisition_test':
            return {'reason': 'FIRST_PURCHASE_CONTROLLER_OWNS_EXACT_EXISTING_AD_NO_NEW_CAMPAIGN'}
        if self.env.get("ALLOW_MICRO_BUDGET", "false").lower() != "true":
            return {"reason": "MICRO_BUDGET_NOT_ENABLED"}
        if live_ads_dry_run(self.env):
            return {"reason": "DRY_RUN_ENABLED"}
        daily_budget_limit = configured_daily_budget_limit_eur(self.env)
        if daily_budget_limit < MicroBudgetGate.DAILY_BUDGET_EUR:
            return {
                "reason": "MICRO_BUDGET_DAILY_LIMIT_TOO_LOW",
                "required_daily_budget_eur": MicroBudgetGate.DAILY_BUDGET_EUR,
                "configured_daily_budget_limit_eur": daily_budget_limit,
            }
        if self.env.get("META_BILLING_VERIFIED", "false").lower() != "true":
            return {"reason": "META_BILLING_NOT_MANUALLY_VERIFIED"}
        if (self.env.get("META_PURCHASE_EVENT_VERIFIED", "false").lower() != "true"
                and not measurement_risk_accepted(self.env)):
            return {"reason": "META_PURCHASE_EVENT_NOT_VERIFIED"}
        token = self.env.get("META_ACCESS_TOKEN", "").strip()
        account_id = self.env.get("META_AD_ACCOUNT_ID", "").strip()
        pixel_id = self.env.get("META_PIXEL_ID", "").strip()
        page_id = self.env.get("META_PAGE_ID", "").strip()
        beneficiary = self.env.get("META_DSA_BENEFICIARY", "").strip()
        payor = self.env.get("META_DSA_PAYOR", "").strip()
        version = self.env.get("META_API_VERSION", "v26.0").strip()
        catalog_id = self.env.get("META_PRODUCT_CATALOG_ID", "").strip()
        product_set_id = self.env.get("META_PRODUCT_SET_ID", "").strip()
        if not token:
            return {"reason": "META_ACCESS_TOKEN_MISSING"}
        if not self.ACCOUNT_PATTERN.fullmatch(account_id):
            return {"reason": "META_AD_ACCOUNT_ID_INVALID"}
        if not self.ID_PATTERN.fullmatch(pixel_id) or not self.ID_PATTERN.fullmatch(page_id):
            return {"reason": "META_PIXEL_OR_PAGE_ID_INVALID"}
        mode = self.env.get("PILOT_AD_MODE", "catalog")
        if mode not in {"catalog", "website_sales"}:
            return {"reason": "PILOT_AD_MODE_INVALID"}
        if mode == "catalog" and (not catalog_id or not self.ID_PATTERN.fullmatch(catalog_id)):
            return {"reason": "META_PRODUCT_CATALOG_ID_MISSING_OR_INVALID"}
        if mode == "catalog" and product_set_id and not self.ID_PATTERN.fullmatch(product_set_id):
            return {"reason": "META_PRODUCT_SET_ID_INVALID"}
        if mode == "website_sales":
            catalog_id = product_set_id = ""
        if not beneficiary or not payor:
            return {"reason": "META_EU_BENEFICIARY_OR_PAYER_MISSING"}
        if len(beneficiary) > 200 or len(payor) > 200:
            return {"reason": "META_EU_BENEFICIARY_OR_PAYER_TOO_LONG"}
        if not self.API_VERSION_PATTERN.fullmatch(version):
            return {"reason": "META_API_VERSION_INVALID"}
        return account_id, page_id, pixel_id, token, version, beneficiary, payor, catalog_id, product_set_id

    def _campaign_name(self) -> str:
        return ("Homestro Website Sales" if self.env.get("PILOT_AD_MODE", "catalog") == "website_sales"
                else "Homestro Catalog Sales All Products")

    def _creative_approved(self, creative: GeneratedCreative, product_id: str) -> bool:
        score = creative.score
        minimum_score = int(self.env.get("PILOT_CREATIVE_MIN_SCORE", "85"))
        return bool(
            creative.publishable_candidate
            and creative.brief.product_id == product_id
            and score.quality_score >= minimum_score
            and score.product_faithful
            and score.logo_visible
            and score.lifestyle_background
            and score.factual_claims_supported
            and creative.asset_path
        )

    async def _preflight(
        self,
        client: httpx.AsyncClient,
        *,
        headers: dict[str, str],
        account_id: str,
        page_id: str,
        pixel_id: str,
    ) -> MetaAccountReadiness:
        account = await self._get(client, account_id, headers, {"fields": "id,account_status,currency,disable_reason"})
        expected_account = account_id.removeprefix("act_")
        returned_account = str(account.get("id", "")).removeprefix("act_")
        try:
            active = (
                returned_account == expected_account
                and int(str(account.get("account_status", ""))) == 1
                and not account.get("disable_reason")
            )
        except (TypeError, ValueError):
            active = False
        pixels = await self._get(client, f"{account_id}/adspixels", headers, {"fields": "id,name,is_unavailable"})
        accessible_pixel = any(
            str(row.get("id")) == pixel_id and not row.get("is_unavailable")
            for row in pixels.get("data", [])
        )
        page = await self._get(client, page_id, headers, {"fields": "id,name"})
        if str(page.get("id", "")) != page_id:
            raise RuntimeError("Meta API returned a different Page ID")
        return MetaAccountReadiness(
            account_id=account_id,
            account_status="active" if active else "disabled",
            currency=str(account.get("currency", "")).upper(),
            billing_ready=self.env.get("META_BILLING_VERIFIED", "false").lower() == "true",
            page_id=page_id,
            pixel_id=pixel_id,
            # A prior event is not required to start a cold-start campaign.
            # Confirm pixel access; optimize for standard AddToCart events.
            # as visitors add products to cart.
            pixel_access_verified=accessible_pixel,
        )

    async def _resolve_all_products_set(
        self,
        client: httpx.AsyncClient,
        catalog_id: str,
        headers: dict[str, str],
    ) -> str | None:
        """Read and select an existing whole-catalog product set; never create one."""
        result = await self._get(
            client,
            f"{catalog_id}/product_sets",
            headers,
            {"fields": "id,name", "limit": "100"},
        )
        rows = result.get("data")
        if not isinstance(rows, list):
            return None
        paging = result.get("paging")
        if isinstance(paging, dict) and paging.get("next"):
            return None
        exact = [
            row for row in rows
            if isinstance(row, dict)
            and str(row.get("name", "")).strip().casefold() in {"all products", "alle produkte"}
            and self.ID_PATTERN.fullmatch(str(row.get("id", "")))
        ]
        # A duplicate label is not sufficient evidence that a set contains the
        # intended catalog scope. Fail closed instead of selecting one by ID.
        if len(exact) != 1:
            return None
        return str(exact[0]["id"])

    async def _get(
        self,
        client: httpx.AsyncClient,
        path: str,
        headers: dict[str, str],
        params: dict[str, str],
    ) -> dict[str, Any]:
        response = await client.get(
            f"{self.ENDPOINT}/{self._version()}/{path}", headers=headers, params=params
        )
        return self._json_response(response)

    async def _post(
        self,
        client: httpx.AsyncClient,
        path: str,
        headers: dict[str, str],
        data: dict[str, str],
    ) -> str:
        response = await client.post(
            f"{self.ENDPOINT}/{self._version()}/{path}", headers=headers, data=data
        )
        body = self._json_response(response)
        object_id = body.get("id")
        if not object_id:
            raise RuntimeError("Meta API returned no object ID")
        return str(object_id)

    async def _upload_image(
        self,
        client: httpx.AsyncClient,
        account_id: str,
        headers: dict[str, str],
        image_bytes: bytes,
    ) -> str:
        response = await client.post(
            f"{self.ENDPOINT}/{self._version()}/{account_id}/adimages",
            headers=headers,
            files={"filename": ("homestro-approved.png", image_bytes, "image/png")},
        )
        body = self._json_response(response)
        images = body.get("images", {})
        image: dict[str, Any] = (
            next(iter(images.values()), {}) if isinstance(images, dict) else {}
        )
        if not isinstance(image, dict) or not image.get("hash"):
            raise RuntimeError("Meta API returned no uploaded image hash")
        return str(image["hash"])

    async def _activate(
        self, client: httpx.AsyncClient, object_id: str, headers: dict[str, str]
    ) -> None:
        from .purchase_guard import PurchaseEvidence, requires_recent_purchase

        evidence = await PurchaseEvidence(env=self.env, client=client).check()
        if requires_recent_purchase(self.env) and not evidence["verified"]:
            raise RuntimeError("FRESH_PURCHASE_REQUIRED_BEFORE_ACTIVATION")
        response = await client.post(
            f"{self.ENDPOINT}/{self._version()}/{object_id}",
            headers=headers,
            data={"status": "ACTIVE"},
        )
        self._json_response(response, require_object_id=False)

    async def _pause_created(
        self, client: httpx.AsyncClient, ids: dict[str, str], headers: dict[str, str]
    ) -> None:
        for object_id in (ids.get("campaign_id"), ids.get("adset_id"), ids.get("ad_id")):
            if not object_id:
                continue
            try:
                response = await client.post(
                    f"{self.ENDPOINT}/{self._version()}/{object_id}",
                    headers=headers,
                    data={"status": "PAUSED"},
                )
                self._json_response(response, require_object_id=False)
            except Exception:
                # Keep the object IDs in the audit record for manual reconciliation.
                continue

    def _version(self) -> str:
        return self.env.get("META_API_VERSION", "v26.0").strip()

    @staticmethod
    def _json_response(
        response: httpx.Response, *, require_object_id: bool = True
    ) -> dict[str, Any]:
        try:
            body = response.json()
        except ValueError as exc:
            raise RuntimeError("Meta API returned a non-JSON response") from exc
        response.raise_for_status()
        if isinstance(body, dict) and body.get("error"):
            error = body["error"]
            code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
            raise RuntimeError(f"Meta API rejected request (code {code})")
        if not isinstance(body, dict):
            raise RuntimeError("Meta API returned an unexpected response")
        if not require_object_id and body.get("success") is False:
            raise RuntimeError("Meta API did not confirm the status change")
        return body


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


class MetaGraphAPIError(RuntimeError):
    """A Meta Graph failure with bounded, non-secret diagnostic fields."""

    def __init__(
        self, status_code: int, code: int | None, subcode: int | None,
        stage: str, details: dict[str, str],
    ) -> None:
        code_text = str(code) if isinstance(code, int) else "unknown"
        subcode_text = str(subcode) if isinstance(subcode, int) else "unknown"
        super().__init__(
            f"META_API_ERROR:{status_code}:{code_text}:{subcode_text}:{stage}"
        )
        self.meta_details = details


class MetaSaaSPublisher:
    """Create one idempotent, PAUSED preview concept; this class never activates ads."""

    API_ROOT = "https://graph.facebook.com"
    EXPECTED_ACCOUNT_ID = "918741266442442"
    EXPECTED_PIXEL_ID = "774286518060183"
    PORTFOLIO_DAILY_CAP_CENTS = 50_000
    ACCOUNT_SPEND_CAP_CENTS = 3_500
    CONCEPT_DAILY_BUDGET_CENTS = 500

    def __init__(
        self,
        token: str,
        account_id: str,
        pixel_id: str,
        page_id: str,
        api_version: str = "v26.0",
        *,
        client: httpx.AsyncClient | None = None,
    ):
        account_number = str(account_id).removeprefix("act_")
        if account_number != self.EXPECTED_ACCOUNT_ID:
            raise ValueError("META_ACCOUNT_NOT_OWNER_APPROVED_A1")
        if str(pixel_id) != self.EXPECTED_PIXEL_ID:
            raise ValueError("META_PIXEL_NOT_MATCHED_TO_SHOPIFY")
        if not re.fullmatch(r"\d{4,30}", str(page_id)):
            raise ValueError("META_PAGE_ID_INVALID")
        if not re.fullmatch(r"v\d+\.\d+", api_version):
            raise ValueError("META_API_VERSION_INVALID")
        if not token:
            raise ValueError("META_ACCESS_TOKEN_MISSING")
        self.account_id = f"act_{account_number}"
        self.pixel_id = str(pixel_id)
        self.page_id = str(page_id)
        self.api_version = api_version
        self.token = token
        self.client = client
        self.write_attempted = False

    async def _call(self, method: str, path: str, *, params=None, data=None) -> dict[str, Any]:
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(35, connect=8), follow_redirects=False
        )
        try:
            response = await client.request(
                method,
                f"{self.API_ROOT}/{self.api_version}/{path.lstrip('/')}",
                headers={"Authorization": f"Bearer {self.token}"},
                params=params,
                data=data,
            )
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if response.status_code >= 400 or not isinstance(payload, dict) or "error" in payload:
                error = payload.get("error", {}) if isinstance(payload, dict) else {}
                code = error.get("code") if isinstance(error, dict) else None
                subcode = error.get("error_subcode") if isinstance(error, dict) else None
                clean_path = path.lstrip("/")
                if clean_path == self.account_id:
                    stage = "account_read"
                elif clean_path == self.page_id:
                    stage = "page_read"
                elif clean_path == f"{self.account_id}/adspixels":
                    stage = "pixel_access_read"
                elif clean_path == f"{self.account_id}/campaigns":
                    stage = (
                        "campaign_create"
                        if method.upper() == "POST"
                        else "campaign_list_read"
                    )
                else:
                    stage = "meta_api_request"
                safe_details: dict[str, str] = {}
                for source, target in (
                    ("type", "meta_error_type"),
                    ("error_user_title", "meta_error_title"),
                    ("error_user_msg", "meta_error_message"),
                    ("message", "meta_error_summary"),
                    ("fbtrace_id", "meta_fbtrace_id"),
                ):
                    value = error.get(source)
                    if isinstance(value, str):
                        safe_details[target] = " ".join(value.split())[:240]
                if stage == "account_read":
                    try:
                        accounts_response = await client.get(
                            f"{self.API_ROOT}/{self.api_version}/me/adaccounts",
                            headers={"Authorization": f"Bearer {self.token}"},
                            params={"fields": "id,account_id", "limit": "100"},
                        )
                        accounts_payload = accounts_response.json()
                        rows = accounts_payload.get("data") if isinstance(accounts_payload, dict) else None
                        if accounts_response.status_code < 400 and isinstance(rows, list):
                            account_ids = [
                                str(row.get("account_id") or row.get("id", ""))
                                for row in rows
                                if isinstance(row, dict)
                            ]
                            target_id = self.account_id.removeprefix("act_")
                            safe_details["meta_target_account_visible"] = (
                                "true" if target_id in account_ids else "false"
                            )
                            safe_details["meta_accessible_ad_account_ids"] = ",".join(
                                account_ids[:50]
                            )[:1000]
                            paging = accounts_payload.get("paging", {})
                            safe_details["meta_account_list_complete"] = (
                                "false"
                                if isinstance(paging, dict) and paging.get("next")
                                else "true"
                            )
                        else:
                            safe_details["meta_accessible_accounts_probe"] = (
                                f"failed_http_{accounts_response.status_code}"
                            )
                    except Exception as probe_exc:
                        safe_details["meta_accessible_accounts_probe"] = (
                            f"failed_{type(probe_exc).__name__}"
                        )
                elif stage == "page_read":
                    try:
                        pages_response = await client.get(
                            f"{self.API_ROOT}/{self.api_version}/me/accounts",
                            headers={"Authorization": f"Bearer {self.token}"},
                            params={"fields": "id,name,tasks", "limit": "100"},
                        )
                        pages_payload = pages_response.json()
                        rows = pages_payload.get("data") if isinstance(pages_payload, dict) else None
                        if pages_response.status_code < 400 and isinstance(rows, list):
                            page_ids = [
                                str(row.get("id", ""))
                                for row in rows
                                if isinstance(row, dict)
                            ]
                            safe_details["meta_target_page_visible"] = (
                                "true" if self.page_id in page_ids else "false"
                            )
                            safe_details["meta_accessible_page_ids"] = ",".join(
                                page_ids[:50]
                            )[:1000]
                            page_names = [
                                f"{row.get('id', '')}:{row.get('name', '')}"
                                for row in rows
                                if isinstance(row, dict)
                            ]
                            safe_details["meta_accessible_pages"] = " | ".join(
                                page_names[:20]
                            )[:1000]
                            paging = pages_payload.get("paging", {})
                            safe_details["meta_page_list_complete"] = (
                                "false"
                                if isinstance(paging, dict) and paging.get("next")
                                else "true"
                            )
                        else:
                            safe_details["meta_accessible_pages_probe"] = (
                                f"failed_http_{pages_response.status_code}"
                            )
                    except Exception as probe_exc:
                        safe_details["meta_accessible_pages_probe"] = (
                            f"failed_{type(probe_exc).__name__}"
                        )
                raise MetaGraphAPIError(
                    response.status_code,
                    code if isinstance(code, int) else None,
                    subcode if isinstance(subcode, int) else None,
                    stage,
                    safe_details,
                )
            return payload
        finally:
            if own_client:
                await client.aclose()

    async def _all_pages(self, path: str, fields: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        after: str | None = None
        for _ in range(50):
            params: dict[str, str] = {"fields": fields, "limit": "100"}
            if after:
                params["after"] = after
            payload = await self._call("GET", path, params=params)
            data = payload.get("data")
            if not isinstance(data, list) or any(not isinstance(x, dict) for x in data):
                raise RuntimeError("META_API_LIST_INVALID")
            rows.extend(data)
            paging = payload.get("paging") or {}
            if not isinstance(paging, dict) or not paging.get("next"):
                return rows
            cursors = paging.get("cursors") or {}
            after = cursors.get("after") if isinstance(cursors, dict) else None
            if not isinstance(after, str) or not after:
                raise RuntimeError("META_API_PAGINATION_INCOMPLETE")
        raise RuntimeError("META_API_PAGE_LIMIT_EXCEEDED")

    async def _check_assets_and_cap(self) -> tuple[list[dict[str, Any]], int]:
        account = await self._call(
            "GET", self.account_id,
            params={"fields": "id,currency,spend_cap"},
        )
        if str(account.get("id", "")).removeprefix("act_") != self.EXPECTED_ACCOUNT_ID:
            raise RuntimeError("META_ACCOUNT_ID_READBACK_MISMATCH")
        if str(account.get("currency", "")).upper() != "EUR":
            raise RuntimeError("META_ACCOUNT_CURRENCY_NOT_EUR")
        try:
            spend_cap_cents = int(str(account.get("spend_cap", "")))
        except (TypeError, ValueError):
            raise RuntimeError("META_ACCOUNT_SPEND_CAP_UNVERIFIED")
        if spend_cap_cents <= 0 or spend_cap_cents > self.ACCOUNT_SPEND_CAP_CENTS:
            raise RuntimeError("META_ACCOUNT_SPEND_CAP_OUTSIDE_35_EUR")

        accessible_pixels = await self._all_pages(
            f"{self.account_id}/adspixels", "id"
        )
        if self.pixel_id not in {str(row.get("id", "")) for row in accessible_pixels}:
            raise RuntimeError("META_PIXEL_NOT_ACCESSIBLE_TO_A1")
        page = await self._call("GET", self.page_id, params={"fields": "id"})
        if str(page.get("id", "")) != self.page_id:
            raise RuntimeError("META_PAGE_ID_READBACK_MISMATCH")

        campaigns = await self._all_pages(
            f"{self.account_id}/campaigns",
            "id,name,status,effective_status,daily_budget,lifetime_budget,adsets{daily_budget,status,effective_status}",
        )
        active_daily_cents = 0
        for campaign in campaigns:
            state = str(campaign.get("effective_status") or campaign.get("status") or "").upper()
            if state != "ACTIVE":
                continue
            if campaign.get("lifetime_budget") not in (None, "", "0", 0):
                raise RuntimeError("ACTIVE_LIFETIME_BUDGET_REQUIRES_REVIEW")
            if campaign.get("daily_budget") not in (None, "", "0", 0):
                active_daily_cents += int(str(campaign["daily_budget"]))
                continue
            adsets = campaign.get("adsets") or {}
            adset_rows = adsets.get("data") if isinstance(adsets, dict) else None
            if not isinstance(adset_rows, list):
                raise RuntimeError("META_ACTIVE_ADSETS_UNREADABLE")
            if isinstance(adsets.get("paging"), dict) and adsets["paging"].get("next"):
                raise RuntimeError("META_ACTIVE_ADSETS_INCOMPLETE")
            for adset in adset_rows:
                if not isinstance(adset, dict):
                    raise RuntimeError("META_ACTIVE_ADSET_INVALID")
                adset_state = str(
                    adset.get("effective_status") or adset.get("status") or ""
                ).upper()
                if adset_state == "ACTIVE":
                    active_daily_cents += int(str(adset.get("daily_budget") or 0))
        if active_daily_cents + self.CONCEPT_DAILY_BUDGET_CENTS > self.PORTFOLIO_DAILY_CAP_CENTS:
            raise RuntimeError("PORTFOLIO_DAILY_CAP_500_EUR_EXCEEDED")
        return campaigns, spend_cap_cents

    async def deploy_paused_concept(
        self, product: dict[str, Any], initial_budget_eur: float = 5.0
    ) -> dict[str, Any]:
        if round(float(initial_budget_eur) * 100) != self.CONCEPT_DAILY_BUDGET_CENTS:
            raise ValueError("CONCEPT_BUDGET_MUST_REMAIN_5_EUR_PER_DAY")
        title = str(product.get("title", "")).strip()
        product_id = str(product.get("id", "")).strip()
        link = str(product.get("link", "")).strip()
        image = str(product.get("image_link", "")).strip()
        parsed_link, parsed_image = urlsplit(link), urlsplit(image)
        if not title:
            raise ValueError("PRODUCT_TITLE_MISSING")
        if not product_id or len(product_id) > 128:
            raise ValueError("SHOPIFY_PRODUCT_ID_INVALID")
        product_key = re.sub(r"[^A-Za-z0-9_-]+", "-", product_id).strip("-")[:64]
        if not product_key:
            raise ValueError("SHOPIFY_PRODUCT_ID_INVALID")
        if (
            parsed_link.scheme != "https"
            or parsed_link.hostname not in {"homestro.de", "www.homestro.de"}
            or parsed_link.username or parsed_link.password
        ):
            raise ValueError("PRODUCT_LINK_NOT_ALLOWED")
        if (
            parsed_image.scheme != "https"
            or not parsed_image.hostname
            or parsed_image.username or parsed_image.password
        ):
            raise ValueError("PRODUCT_IMAGE_NOT_ALLOWED")
        campaigns, account_cap_cents = await self._check_assets_and_cap()
        concept_name = f"AUTOPILOT CONCEPT // {product_key} // {title}"[:240]
        campaign_id = ""
        for existing_campaign in campaigns:
            if str(existing_campaign.get("name", "")) != concept_name:
                continue
            existing_campaign_id = str(existing_campaign.get("id", ""))
            existing_status = str(
                existing_campaign.get("effective_status")
                or existing_campaign.get("status")
                or ""
            ).upper()
            if existing_status not in {"PAUSED", "CAMPAIGN_PAUSED"}:
                return {
                    "status": "SKIPPED_DUPLICATE",
                    "campaign_id": existing_campaign_id,
                    "campaign_name": concept_name,
                    "campaign_status": existing_status,
                }
            campaign_id = existing_campaign_id
            break

        now = datetime.now(timezone.utc)
        starts = (now + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S%z")
        ends = (now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S%z")
        if not campaign_id:
            self.write_attempted = True
            campaign = await self._call(
                "POST", f"{self.account_id}/campaigns",
                data={
                    "name": concept_name,
                    "objective": "OUTCOME_SALES",
                    "status": "PAUSED",
                    "special_ad_categories": "[]",
                    "is_adset_budget_sharing_enabled": "false",
                },
            )
            campaign_id = str(campaign.get("id", ""))
            if not re.fullmatch(r"\d{4,30}", campaign_id):
                raise RuntimeError("META_CAMPAIGN_ID_MISSING")

        adset_name = f"Concept // DE-AT // {product_key}"
        existing_adsets = await self._call(
            "GET", f"{campaign_id}/adsets",
            params={"fields": "id,name,status,effective_status", "limit": "100"},
        )
        existing_rows = existing_adsets.get("data")
        if not isinstance(existing_rows, list) or (
            isinstance(existing_adsets.get("paging"), dict)
            and existing_adsets["paging"].get("next")
        ):
            raise RuntimeError("META_EXISTING_ADSETS_UNVERIFIED")
        if existing_rows:
            matching_adsets = [
                row for row in existing_rows
                if isinstance(row, dict) and str(row.get("name", "")) == adset_name
            ]
            if len(matching_adsets) != 1:
                return {
                    "status": "BLOCKED",
                    "reason": "EXISTING_ADSET_SCOPE_AMBIGUOUS",
                    "campaign_id": campaign_id,
                    "writes_performed": True,
                }
            existing_adset_id = str(matching_adsets[0].get("id", ""))
            existing_ads = await self._call(
                "GET", f"{existing_adset_id}/ads",
                params={"fields": "id,status,creative", "limit": "100"},
            )
            existing_ad_rows = existing_ads.get("data")
            if not isinstance(existing_ad_rows, list) or (
                isinstance(existing_ads.get("paging"), dict)
                and existing_ads["paging"].get("next")
            ) or len(existing_ad_rows) != 1:
                return {
                    "status": "BLOCKED",
                    "reason": "EXISTING_AD_SCOPE_UNVERIFIED",
                    "campaign_id": campaign_id,
                    "adset_id": existing_adset_id,
                    "writes_performed": True,
                }
            existing_ad = existing_ad_rows[0]
            existing_ad_id = str(existing_ad.get("id", ""))
            existing_creative = existing_ad.get("creative")
            existing_creative_id = (
                str(existing_creative.get("id", ""))
                if isinstance(existing_creative, dict) else ""
            )
            final_campaign = await self._call(
                "GET", campaign_id, params={"fields": "id,status,effective_status"}
            )
            final_adset = await self._call(
                "GET", existing_adset_id, params={"fields": "id,status,effective_status"}
            )
            final_ad = await self._call(
                "GET", existing_ad_id, params={"fields": "id,status,effective_status"}
            )
            configured_statuses = [
                str(final_campaign.get("status", "")).upper(),
                str(final_adset.get("status", "")).upper(),
                str(final_ad.get("status", "")).upper(),
            ]
            effective_statuses = [
                str(final_campaign.get("effective_status", "")).upper(),
                str(final_adset.get("effective_status", "")).upper(),
                str(final_ad.get("effective_status", "")).upper(),
            ]
            if any(status != "PAUSED" for status in configured_statuses):
                return {
                    "status": "BLOCKED",
                    "reason": "META_CONFIGURED_STATUS_NOT_PAUSED",
                    "campaign_id": campaign_id,
                    "adset_id": existing_adset_id,
                    "creative_id": existing_creative_id,
                    "ad_id": existing_ad_id,
                    "configured_statuses": configured_statuses,
                    "effective_statuses": effective_statuses,
                    "writes_performed": True,
                }
            return {
                "status": "CONCEPT_RECONCILED",
                "campaign_id": campaign_id,
                "adset_id": existing_adset_id,
                "creative_id": existing_creative_id,
                "ad_id": existing_ad_id,
                "campaign_status": configured_statuses[0],
                "adset_status": configured_statuses[1],
                "ad_status": configured_statuses[2],
                "effective_statuses": effective_statuses,
                "daily_budget_eur": "5.00",
                "account_spend_cap_cents": account_cap_cents,
                "product_id": product_id,
                "product_title": title,
                "creative_card_count": 1,
                "reconciled_existing_objects": True,
                "writes_performed": True,
            }

        self.write_attempted = True
        adset = await self._call(
            "POST", f"{self.account_id}/adsets",
            data={
                "name": adset_name,
                "campaign_id": campaign_id,
                "daily_budget": str(self.CONCEPT_DAILY_BUDGET_CENTS),
                "billing_event": "IMPRESSIONS",
                "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                "optimization_goal": "OFFSITE_CONVERSIONS",
                "destination_type": "WEBSITE",
                "start_time": starts,
                "end_time": ends,
                "promoted_object": json.dumps({
                    "pixel_id": self.pixel_id,
                    "custom_event_type": "PURCHASE",
                }),
                "targeting": json.dumps({
                    "geo_locations": {"countries": ["DE", "AT"]},
                    "age_min": 18,
                    "publisher_platforms": ["facebook", "instagram"],
                }),
                "status": "PAUSED",
            },
        )
        adset_id = str(adset.get("id", ""))
        if not re.fullmatch(r"\d{4,30}", adset_id):
            raise RuntimeError("META_ADSET_ID_MISSING")
        story = {
            "page_id": self.page_id,
            "link_data": {
                "link": link,
                "picture": image,
                "name": title[:40],
                "message": f"{title}. Details, Varianten und aktuelle Preise findest du bei Homestro.",
                "description": str(product.get("description", ""))[:300],
                "call_to_action": {"type": "SHOP_NOW", "value": {"link": link}},
            },
        }
        creative = await self._call(
            "POST", f"{self.account_id}/adcreatives",
            data={
                "name": f"Paused concept // {product_key}"[:240],
                "object_story_spec": json.dumps(story, ensure_ascii=False),
            },
        )
        creative_id = str(creative.get("id", ""))
        if not re.fullmatch(r"\d{4,30}", creative_id):
            raise RuntimeError("META_CREATIVE_ID_MISSING")
        ad = await self._call(
            "POST", f"{self.account_id}/ads",
            data={
                "name": f"Paused concept ad // {product_key}"[:240],
                "adset_id": adset_id,
                "creative": json.dumps({"creative_id": creative_id}),
                "status": "PAUSED",
            },
        )
        ad_id = str(ad.get("id", ""))
        if not re.fullmatch(r"\d{4,30}", ad_id):
            raise RuntimeError("META_AD_ID_MISSING")

        final_campaign = await self._call(
            "GET", campaign_id, params={"fields": "id,status,effective_status"}
        )
        final_adset = await self._call(
            "GET", adset_id, params={"fields": "id,status,effective_status"}
        )
        final_ad = await self._call(
            "GET", ad_id, params={"fields": "id,status,effective_status"}
        )
        statuses = [
            str(final_campaign.get("effective_status") or final_campaign.get("status") or "").upper(),
            str(final_adset.get("effective_status") or final_adset.get("status") or "").upper(),
            str(final_ad.get("effective_status") or final_ad.get("status") or "").upper(),
        ]
        if any(status not in {"PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"} for status in statuses):
            raise RuntimeError("META_PAUSED_STATUS_READBACK_FAILED")

        preview_url = None
        preview_status = "UNAVAILABLE"
        try:
            preview = await self._call(
                "GET", f"{ad_id}/previews",
                params={"ad_format": "DESKTOP_FEED_STANDARD"},
            )
            preview_rows = preview.get("data")
            html = (
                str(preview_rows[0].get("body", ""))
                if isinstance(preview_rows, list) and preview_rows
                and isinstance(preview_rows[0], dict)
                else ""
            )
            match = re.search(r"<iframe[^>]+src=[\"']([^\"']+)", html, re.IGNORECASE)
            candidate = __import__("html").unescape(match.group(1)) if match else ""
            preview_parts = urlsplit(candidate)
            if (
                preview_parts.scheme == "https"
                and preview_parts.hostname in {"facebook.com", "www.facebook.com"}
                and preview_parts.path.startswith("/ads/api/preview_iframe.php")
                and "access_token" not in preview_parts.query.lower()
            ):
                preview_url = candidate
                preview_status = "READY"
        except Exception:
            preview_status = "UNAVAILABLE"

        ads_manager_url = (
            "https://www.facebook.com/adsmanager/manage/ads"
            f"?act={self.EXPECTED_ACCOUNT_ID}&selected_ad_ids={ad_id}"
        )
        return {
            "status": "CONCEPT_CREATED",
            "campaign_id": campaign_id,
            "adset_id": adset_id,
            "creative_id": creative_id,
            "ad_id": ad_id,
            "campaign_status": statuses[0],
            "adset_status": statuses[1],
            "ad_status": statuses[2],
            "daily_budget_eur": "5.00",
            "account_spend_cap_cents": account_cap_cents,
            "window_start_utc": starts,
            "window_end_utc": ends,
            "product_id": product_id,
            "product_title": title,
            "creative_card_count": 1,
            "owner_preview_authorization_required": True,
            "preview_url": preview_url,
            "preview_status": preview_status,
            "ads_manager_url": ads_manager_url,
        }
