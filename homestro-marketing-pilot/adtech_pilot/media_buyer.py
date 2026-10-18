"""Performance analysis, competitor intelligence and budget-safe media execution."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field, model_validator

from .creative_factory import CreativeFactory, GeneratedCreative
from .micro_budget import (
    MetaAccountReadiness,
    MicroBudgetGate,
    configured_daily_budget_limit_eur,
    live_ads_dry_run,
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

    async def publish_one(
        self,
        *,
        creative: GeneratedCreative,
        product: dict[str, Any],
        product_ids_in_feed: set[str],
    ) -> dict[str, Any]:
        config = self._configuration()
        if isinstance(config, dict):
            return {"status": "blocked", **config}
        account_id, page_id, pixel_id, token, version, beneficiary, payor = config
        product_id = str(product.get("id", ""))
        if not self._creative_approved(creative, product_id):
            return {"status": "blocked", "reason": "CREATIVE_NOT_APPROVED_OR_PRODUCT_MISMATCH"}
        try:
            image_bytes = Path(creative.asset_path).read_bytes()
        except OSError:
            return {"status": "blocked", "reason": "CREATIVE_ASSET_NOT_FOUND"}
        allowed_root = Path(self.env.get("PILOT_CREATIVE_DIR", "/data/adtech-creatives"))
        try:
            Path(creative.asset_path).resolve().relative_to(allowed_root.resolve())
        except ValueError:
            return {"status": "blocked", "reason": "CREATIVE_ASSET_OUTSIDE_APPROVED_DIRECTORY"}
        if len(image_bytes) > 8_000_000:
            return {"status": "blocked", "reason": "CREATIVE_ASSET_TOO_LARGE"}
        try:
            plain_white = CreativeFactory._is_plain_white_image(image_bytes)
        except Exception:
            return {"status": "blocked", "reason": "CREATIVE_IMAGE_INVALID"}
        if plain_white:
            return {"status": "blocked", "reason": "CREATIVE_WHITE_BACKGROUND_REJECTED"}
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
        if str(self.env.get("MICRO_BUDGET_PRODUCT_ID", "")).strip() != product_id:
            return {"status": "blocked", "reason": "PRODUCT_IS_NOT_EXPLICITLY_SELECTED"}
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(35, connect=8), follow_redirects=False
        )
        headers = {"Authorization": f"Bearer {token}"}
        created_ids: dict[str, str] = {}
        claim_acquired = False
        resumed_campaign: str | None = None
        try:
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
                    reconciliation = await self._reconcile_failed_campaign(
                        client, headers, resumed_campaign
                    )
                    if reconciliation != "ready":
                        return {
                            "status": "blocked",
                            "reason": "PRIOR_CAMPAIGN_NOT_SAFE_TO_RESUME",
                            "campaign_id": resumed_campaign,
                            "reconciliation": reconciliation,
                        }
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
                product_id=product_id,
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
                        "name": f"Homestro Micro Test {product_id[:40]}",
                        "objective": "OUTCOME_SALES",
                        "status": "PAUSED",
                        "special_ad_categories": "[]",
                        "is_adset_budget_sharing_enabled": "false",
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
                        "name": f"Homestro DE AddToCart {product_id[:32]}",
                        "campaign_id": campaign,
                        "daily_budget": str(self.DAILY_BUDGET_CENTS),
                    "billing_event": "IMPRESSIONS",
                    "optimization_goal": "OFFSITE_CONVERSIONS",
                    "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                    "destination_type": "WEBSITE",
                    "promoted_object": json.dumps(
                        {"pixel_id": pixel_id, "custom_event_type": "ADD_TO_CART"}
                    ),
                    "dsa_beneficiary": beneficiary,
                    "dsa_payor": payor,
                    "targeting": json.dumps(
                        {
                            "geo_locations": {"countries": ["DE"]},
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
            image_hash = await self._upload_image(
                client, account_id, headers, image_bytes
            )
            brief = creative.brief
            adcreative = await self._post(
                client,
                f"{account_id}/adcreatives",
                headers,
                {
                    "name": f"Homestro Approved {product_id[:32]}",
                    "object_story_spec": json.dumps(
                        {
                            "page_id": page_id,
                            "link_data": {
                                "image_hash": image_hash,
                                "link": link,
                                "message": brief.primary_text,
                                "name": brief.headline,
                                "description": brief.description,
                                "call_to_action": {
                                    "type": "SHOP_NOW",
                                    "value": {"link": link},
                                },
                            },
                        }
                    ),
                },
            )
            ad = await self._post(
                client,
                f"{account_id}/ads",
                headers,
                {
                    "name": f"Homestro Test Ad {product_id[:32]}",
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
                "product_id": product_id,
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

    async def _reconcile_failed_campaign(
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
        expected_name = f"Homestro Micro Test {product_id[:40]}"
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
    ) -> tuple[str, str, str, str, str, str, str] | dict[str, Any]:
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
        token = self.env.get("META_ACCESS_TOKEN", "").strip()
        account_id = self.env.get("META_AD_ACCOUNT_ID", "").strip()
        pixel_id = self.env.get("META_PIXEL_ID", "").strip()
        page_id = self.env.get("META_PAGE_ID", "").strip()
        beneficiary = self.env.get("META_DSA_BENEFICIARY", "").strip()
        payor = self.env.get("META_DSA_PAYOR", "").strip()
        version = self.env.get("META_API_VERSION", "v26.0").strip()
        if not token:
            return {"reason": "META_ACCESS_TOKEN_MISSING"}
        if not self.ACCOUNT_PATTERN.fullmatch(account_id):
            return {"reason": "META_AD_ACCOUNT_ID_INVALID"}
        if not self.ID_PATTERN.fullmatch(pixel_id) or not self.ID_PATTERN.fullmatch(page_id):
            return {"reason": "META_PIXEL_OR_PAGE_ID_INVALID"}
        if not beneficiary or not payor:
            return {"reason": "META_EU_BENEFICIARY_OR_PAYER_MISSING"}
        if len(beneficiary) > 200 or len(payor) > 200:
            return {"reason": "META_EU_BENEFICIARY_OR_PAYER_TOO_LONG"}
        if not self.API_VERSION_PATTERN.fullmatch(version):
            return {"reason": "META_API_VERSION_INVALID"}
        return account_id, page_id, pixel_id, token, version, beneficiary, payor

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
