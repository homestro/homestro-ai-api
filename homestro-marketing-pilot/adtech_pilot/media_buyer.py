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
    actions: list[BudgetActionm«ëŒ+Š×ž®º+º$zzb¥åÒÒµÐ¢–bæ÷BGG&–'WF–öå÷fW&–f–VC ¢7F–öç2Ò°¢'VFvWD7F–öâ€¢ÆFf÷&ÓÖÒçÆFf÷&ÒÀ¢6×–våö–CÖÒæ6×–våö–BÀ¢7F–öãÔ7F–öåG—Rä„ôÄBÀ¢Ö÷VçEöWW#ÓÀ¢&F–öæÆSÒ$†öÆC¢W&6†6RGG&–'WF–öâæB6öçG&–'WF–öâÖ&v–â&Ræ÷BfW&–f–VBâ"À¢Wf–FVæ6S×²'&ö2#¢Òç&ö2Â&7G"#¢Òæ7G"Â&7öWW"#¢Òæ7öWW'ÒÀ¢¢f÷"Ò–âÖWG&–70¢Ð¢&WGW&â÷F–Ö—¦F–öåÆâ€¢–çFW'fÅö†÷W'3Ö–çFW'fÅö†÷W'2À¢GG&–'WF–öå÷fW&–f–VCÔfÇ6RÀ¢7W'&VçE÷÷'FföÆ–õöF–Ç•ö'VFvWEöWW#Ö7W'&VçE÷÷'FföÆ–õöF–Ç•ö'VFvWEöWW"À¢&÷÷6VE÷÷'FföÆ–õöF–Ç•ö'VFvWEöWW#Ö7W'&VçE÷÷'FföÆ–õöF–Ç•ö'VFvWEöWW"À¢7F–öç3Ö7F–öç2À¢ ¢VæFW'W&f÷&ÖW'2Ò°¢Ð¢f÷"Ò–âÖWG&–70¢–bÒç7VæEöWW"ãÒöÆ–7’æÖ–å÷7VÛjÇºã
âµç«®ŠÁ®‰ž˜©zd_before_pause_eur
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
                    rationale=f"Proposed pause: spend â‚¬{m.spend_eur:.2f} with ROAS {m.roas or 0:.2f}, below the policy floor.",
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
            with closing(self._connect()) as connection, connectim«ëŒ+Š×ž®º+º$zzb¥æöã ¢7W'6÷"Ò6öææV7F–öâæW†V7WFR€¢$DTÄUDRe$ôÒÖWFöÖ–7&õö6×–våö6Æ–Ò ¢%t„U$R6Æ÷CÓòäB7FGW3Òtd”ÄTEô…EE7FGW4W'&÷"räB6×–våö–B•2åTÄÂ"À¢‚'6–ævÆUöÆ—fUöÖWFö6×–vâ"Â’À¢¢&WGW&â7W'6÷"ç&÷v6÷VçBÓÒ ¢&WGW&âv—B7–æ6–òçFõ÷F‡&VB†FVÆWFR ¢7–æ2FVb&VÆV6Uö–æ7F—fUö6Æ–Ò€¢6VÆbÂ¢Â6×–våö–C¢7G"ÂW‡V7FVE÷7FGW3¢7G ¢’Óâ&ööÃ ¢""%&VÆV6RF†RÆö6Â6Æ÷BöæÇ’f÷"F†RW†7B&V6öæ6–ÆVB–æ7F—fR6×–vââ"" ¢–bW‡V7FVE÷7FGW2æ÷B–â°¢$5D•dUõTäD”äuõ$Ud”Ur"À¢%$T4ôä4”ÄTEôU„•5D”äuô4Õ”tâ"À¢Ó ¢&WGW&âfÇ6P ¢FVbFVÆWFR‚’Óâ&ööÃ ¢v—F‚6Æ÷6–ær‡6VÆbåö6öææV7B‚’’26öææV7F–öâÂ6öææV7F–öã ¢7W'6÷"Ò6öææV7F–öâæW†V7WFR€¢$DTÄUDRe$ôÒÖWFöÖ–7&õö6×–våö6Æ–Ò ¢%t„U$R6Æ÷CÓòäB7FGW3ÓòäB6×–våö–CÓò"À¢‚'6–ævÆUöÆ—fUöÖWFö6×–vâ"ÂW‡V7FVE÷7FGW2Â6×–våö–B’À¢¢–b7W'6÷"ç&÷v6÷VçBÓÒ ¢6öææV7F–öâæW†V7WFR€¢$”å4U%B”åDòGFV6…öVF—B†–BÆ¶–æBÆ7&VFVEöBÇ–ÆöEö§6öâ’dÅTU2ƒòÃòÃòÃò’"À¢‡7G"‡WV–CB‚’’Â&ÖWFö6×–våö&6†—fVB"ÂFFWF–ÖRææ÷r‡F–ÖW¦öæRçWF2’æ—6öf÷&ÖB‚’À¢§6öâæGV×2‡²&6×–våö–B#¢6×–våö–BÂ'7FGW2#¢$”ä5D•dR"À¢'&–÷%÷7FGW2#¢W‡V7FVE÷7FGW7Ò’’À¢¢&WGW&â7W'6÷"ç&÷v6÷VçBÓÒ ¢&WGW&âv—B7–æ6–òçFõ÷F‡&VB†FVÆWFR ¢7–æ2FVb†5öÖWFöÖ–7&õö6×–våö6Æ–Ò‡6VÆb’Óâ&ööÃ ¢&WGW&âv—B6VÆbævWEöÖWFöÖ–7&õö6×–våö6Æ–Ò‚’—2æ÷BæöæP ¢7–æ2FVb&V6÷&B‡6VÆbÂ¶–æC¢7G"Â–ÆöC¢&6TÖöFVÂÂF–7E·7G"Âç•Ò’Óâ7G# ¢6W&–Æ—¦VBÒ€¢–ÆöBæÖöFVÅöGV×ö§6öâ‚¢–b—6–ç7Fæ6R‡–ÆöBÂ&6TÖöFVÂ¢VÇ6R§6öâæGV×2‡–ÆöBÂFVfVÇC×7G"Â6W&F÷'3Ò‚"Â"Â#¢"’¢¢&V6÷&Eö–BÒ7G"‡WV–CB‚’¢7&VFVEöBÒFFWF–ÖRææ÷r‡F–ÖW¦öæRçWF2’æ—6öf÷&ÖB‚ ¢FVbw&—FR‚’ÓâæöæS ¢v—F‚6Æ÷6–ær‡6VÆbåö6öææV7B‚’’26öææV7F–öâÂ6öææV7F–öã ¢6öææV7F–öâæW†V7WFR€¢$”å4U%B”åDòGFV6…öVF—B†–BÆ¶–æBÆ7&VFVEöBÇ–ÆöEö§6öâ’dÅTU2ƒòÃòÃòÃò’"À¢‡&V6÷&Eö–BÂ¶–æE³£CÒÂ7&VFVEöBÂ6W&–Æ—¦VB’À¢¢6öææV7F–öâæW†V7WFR€¢$DTÄUDRe$ôÒGFV6…öVF—Bt„U$R§VÆ–æF’†7&VFVEöB’Â§VÆ–æF’‚væ÷rrÂrÓ“F—2r’ ¢ ¢v—B7–æ6–òçFõ÷F‡&VB‡w&—FR¢&WGW&â&V6÷&Eö–@ ¢7–æ2FVbÆFW7Eö'&–åöWf–FVæ6R‡6VÆb’ÓâF–7E·7G"Âç•Ó ¢g&öÒæ'&–å÷7FGW2–×÷'B´”äE0 ¢FVb&VB‚“ ¢&W7VÇBÒ·Ð¢v—F‚6Æ÷6–ær‡6VÆbåö6öææV7B‚’’26öææV7F–öã ¢f÷"¶–æB–â´”äE3 ¢&÷rÒ6öææV7F–öâæW†V7WFR€¢%4TÄT5B7&VFVEöBÇ–ÆöEö§6öâe$ôÒGFV6…öVF—Bt„U$R¶–æCÓòõ$DU"%’7&VFVEöBDU42Ä”Ô•B"À¢†¶–æBÂ’’æfWF6†öæR‚¢–b&÷s ¢&W7VÇE¶¶–æEÒÒ²&7&VFVEöB#¢&÷u³ÒÂ'–ÆöB#¢§6öâæÆöG2‡&÷u³Ò—Ð¢F&ÆRÒ6öææV7F–öâæW†V7WFR‚%4TÄT5Be$ôÒ7Æ—FUöÖ7FW"t„U$RG—SÒwF&ÆRräBæÖSÒw–Æ÷Eö'&–åöÖVÖ÷'’r"’æfWF6†öæR‚¢6Æ–ÒÒ6öææV7F–öâæW†V7WFR‚%4TÄT5B6×–våö–Be$ôÒÖWFöÖ–7&õö6×–våö6Æ–Òt„U$R6Æ÷CÓò"À¢‚'6–ævÆUöÆ—fUöÖWFö6×–vâ"Â’’æfWF6†öæR‚¢–bF&ÆRæB6Æ–ÒæB6Æ–Õ³Ó ¢&÷rÒ6öææV7F–öâæW†V7WFR‚%4TÄT5B–ÆöBe$ôÒ–Æ÷Eö'&–åöÖVÖ÷'’t„U$R6×–vãÓò"Â†6Æ–Õ³ÒÂ’’æfWF6†öæR‚¢–b&÷s ¢7FFRÒ§6öâæÆöG2‡&÷u³Ò¢ÆÆ÷vVBÒ‚&Eö–B"Â&7&VF—fUö–B"Â'G&6¶–æuö–ç7FÆÆVB"Â&7W'&VçE÷&öGV7Eö–G2"Â&Æ7E÷&÷FF–öåöB"Â&–æfÆ–v‡B"¢&W7VÇE²&'&–åöÖVÖ÷'’%ÒÒ²'–ÆöB#¢¶¶W“¢7FFRævWB†¶W’’f÷"¶W’–âÆÆ÷vVG×Ð¢&WGW&â&W7VÇ@¢&WGW&âv—B7–æ6–òçFõ÷F‡&VB‡&VB ¢7–æ2FVbÆ—7B‡6VÆbÂÆ–Ö—C¢–çBÒS’ÓâÆ—7E¶F–7E·7G"Âç•ÕÓ ¢Æ–Ö—BÒÖ‚ƒÂÖ–â†Æ–Ö—BÂ#’ ¢FVb&VB‚’ÓâÆ—7E¶F–7E·7G"Âç•ÕÓ ¢v—F‚6Æ÷6–ær‡6VÆbåö6öææV7B‚’’26öææV7F–öã ¢&÷w2Ò6öææV7F–öâæW†V7WFR€¢%4TÄT5B–BÆ¶–æBÆ7&VFVEöBÇ–ÆöEö§6öâe$ôÒGFV6…öVF—Bõ$DU"%’7&VFVEöBÚ±î¸Â¸­yêë¢°k¢G§¦*^DESC LIMIT ?",
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

    async def latest_record(self, kind: str) -> dict[str, Any] | None:
        """Read the newest audit item of one kind for bounded worker caches."""
        def read() -> dict[str, Any] | None:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT id,kind,created_at,payload_json FROM adtech_audit "
                    "WHERE kind=? ORDER BY created_at DESC LIMIT 1",
                    (kind[:40],),
                ).fetchone()
            if row is None:
                return None
            return {
                "id": row[0],
                "kind": row[1],
                "created_at": row[2],
                "payload": json.loads(row[3]),
            }

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
                blocked_ream«ëŒ+Š×ž®º+º$zzb¥ç6öãÒ$ÕTÅD•ô5D”ôåõ$UT•$U5õ4t"À¢Æã×6fU÷ÆâÀ¢¢FFW'2ÒFFW'2÷"·Ð¢–bç’€¢æ7F–öâÒ7F–öåG—Rä„ôÄBæBçÆFf÷&Òæ÷B–âFFW'0¢f÷"–â6fU÷Æâæ7F–öç0¢“ ¢&WGW&âW†V7WF–öå&W7VÇB€¢G'•÷'VãÔfÇ6RÀ¢Ö…ö'VFvWEöÆ–Ö—EöWW#×6VÆbæÖ…ö'VFvWEöÆ–Ö—BÀ¢×WFF–öå÷W&f÷&ÖVCÔfÇ6RÀ¢&Æö6¶VE÷&V6öãÒ%ÄDdõ$ÕôDDU%ôÔ•54”är"À¢Æã×6fU÷ÆâÀ¢¢&W7VÇG3¢Æ—7E¶F–7E·7G"Âç•ÕÒÒµÐ¢2Ç’&VGV7F–öç2&Vf÷&Rç’–æ7&V6R6òG&ç6–VçB'VFvWBæWfW"W†6VVG2F†R÷'FföÆ–ò6à¢÷&FW&VEö7F–öç2Ò6÷'FVB€¢6fU÷Æâæ7F–öç2À¢¶W“ÖÆÖ&F¢–bæ7F–öâ–â´7F–öåG—Rå$TET4RÂ7F–öåG—RåU4WÒVÇ6RÀ¢¢f÷"7F–öâ–â÷&FW&VEö7F–öç3 ¢–b7F–öâæ7F–öâÓÒ7F–öåG—Rä„ôÄC ¢6öçF–çVP¢G'“ ¢&W7VÇBÒv—BFFW'5¶7F–öâçÆFf÷&ÕÒæÇ•ö7F–öâ†7F–öâ¢&W7VÇG2æVæB€¢°¢'ÆFf÷&Ò#¢7F–öâçÆFf÷&ÒçfÇVRÀ¢&6×–våö–B#¢7F–öâæ6×–våö–BÀ¢&7F–öâ#¢7F–öâæ7F–öâçfÇVRÀ¢'&W7VÇB#¢&W7VÇBÀ¢Ð¢¢W†6WBW†6WF–öã ¢2Fòæ÷B&WG'’âÖ&–wV÷W2&VÖ÷FRw&—FRâ&V6÷&BF†R'F–Â7FFRf÷"ÖçVÂ&V6öæ6–Æ–F–öâà¢&WGW&âW†V7WF–öå&W7VÇB€¢G'•÷'VãÔfÇ6RÀ¢Ö…ö'VFvWEöÆ–Ö—EöWW#×6VÆbæÖ…ö'VFvWEöÆ–Ö—BÀ¢×WFF–öå÷W&f÷&ÖVCÖ&ööÂ‡&W7VÇG2’À¢&Æö6¶VE÷&V6öãÒ%$õd”DU%ôõUD4ôÔUõ$UT•$U5õ$T4ôä4”Ä”D”ôâ"À¢Æã×6fU÷ÆâÀ¢&÷f–FW%÷&W7VÇG3×&W7VÇG2À¢¢&WGW&âW†V7WF–öå&W7VÇB€¢G'•÷'VãÔfÇ6RÀ¢Ö…ö'VFvWEöÆ–Ö—EöWW#×6VÆbæÖ…ö'VFvWEöÆ–Ö—BÀ¢×WFF–öå÷W&f÷&ÖVCÖ&ööÂ‡&W7VÇG2’À¢Æã×6fU÷ÆâÀ¢&÷f–FW%÷&W7VÇG3×&W7VÇG2À¢  ¦6Æ726ö×WF—F÷$B„&6TÖöFVÂ“ ¢Æ–'&'•ö–C¢7G ¢vUöæÖS¢7G ¢Eö6÷“¢Æ—7E·7G%ÒÒf–VÆB†FVfVÇEöf7F÷'“ÖÆ—7B¢ÆFf÷&×3¢Æ—7E·7G%ÒÒf–VÆB†FVfVÇEöf7F÷'“ÖÆ—7B¢7F'FVEöC¢7G"ÂæöæRÒæöæP¢6æ6†÷E÷W&Ã¢7G"ÂæöæRÒæöæP¢–çFVÅö¶–æC¢7G"Ò'V&Æ–5öE÷7G'V7GW&UööæÇ•öæõ÷W&f÷&Öæ6UöFF   ¦6Æ72ÖWFDÆ–'&'”6Æ–VçC ¢""$öff–6–ÂÖWFBÆ–'&'’’öæÇ“²FVÆ–&W&FVÇ’æò'&÷w6W"67&–ærâ""  ¢TäEô”åBÒ&‡GG3¢òöw&‚æf6V&öö²æ6öÒ  ¢FVbõö–æ—Eõò€¢6VÆbÀ¢66W75÷Fö¶Vã¢7G"À¢¢À¢•÷fW'6–öã¢7G"Ò'c#bã"À¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÂæöæRÒæöæRÀ¢“ ¢–bæ÷B66W75÷Fö¶Vâ÷"æ÷B•÷fW'6–öâç7F'G7v—F‚‚'b"“ ¢&—6RfÇVTW'&÷"‚$ÖWFBÆ–'&'’7&VFVçF–Ç2æB’fW'6–öâ&R&WV—&VB"¢6VÆbæ66W75÷Fö¶VâÂ6VÆbæ•÷fW'6–öâÂ6VÆbæ6Æ–VçBÒ€¢66W75÷Fö¶VâÀ¢•÷fW'6–öâÀ¢6Æ–VçBÀ¢ ¢7–æ2FVb6V&6‚€¢6VÆbÀ¢FW&×3¢Æ—7E·7G%ÒÀ¢¢À¢6÷VçG'“¢7G"Ò$DR"À¢Æ–Ö—C¢–çBÒ#RÀ¢7F—fUööæÇ“¢&ööÂÒfÇ6RÀ¢’ÓâÆ—7E´6ö×WF—F÷$EÓ ¢–b6÷VçG'’æ÷B–â²$DR"Â$B"Â$4‚"Â%U2"Â$t""Â$e""Â$•B"Â$U2"Â$äÂ'Ó ¢&—6RfÇVTW'&÷"‚%Vç7W÷'FVB6÷VçG'’6öFR"¢&÷VæFVE÷FW&×2Ò""æ¦ö–â‚""æ¦ö–â‡FW&×2’ç7Æ—B‚’•³£#Ð¢–bæ÷B&÷VæFVE÷FW&×2÷"æ÷BÃÒÆ–Ö—BÃÒS ¢&—6RfÇVTW'&÷"‚%6V&6‚FW&×2æBÆ–Ö—Bg&öÒFòS&R&WV—&VB"¢6Æ–VçBÒ6VÆbæ6Æ–VçB÷"‡GG‚ä7–æ46Æ–VçB‡F–ÖV÷WCÖ‡GG‚åF–ÖV÷WBƒ#Â6öææV7CÓR’¢÷våö6Æ–VçBÒ6VÆbæ6Æ–VçB—2æöæP¢G'“ ¢&×3¢F–7E·7G"Â7G"Â–çEÒÒ°¢'6V&6…÷FW&×2#¢&÷VæFVE÷FW&×2À¢&E÷G—R#¢$ÄÂ"À¢&E÷&V6†VEö6÷VçG&–W2#¢§6öâæGV×2…¶6÷VçG'•Ò’À¢&f–VÆG2#¢&–BÇvUöæÖRÆEö7&VF—fUö&öF–W2ÇV&Æ—6†W%÷ÆFf÷&×2ÆEöFVÆ—fW'•÷7F'E÷F–ÖRÆE÷6æ6†÷E÷W&Â"À¢&Æ–Ö—B#¢Æ–Ö—BÀ¢Ð¢–b7F—fUööæÇ“ ¢&×5²&Eö7F—fU÷7FGW2%ÒÒ$5D•dR ¢&W7öç6RÒv—B6Æ–VçBævWB€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbæ•÷fW'6–öçÒöG5ö&6†—fR"À¢†VFW'3×²$WF†÷&—¦F–öâ#¢b$&V&W"·6VÆbæ66W75÷Fö¶VçÒ'ÒÀ¢&×3×&×2À¢¢&W7öç6Rç&—6Uöf÷%÷7FGW2‚¢&÷w2Ò&W7öç6Ræ§6öâ‚’ævWB‚&FF"ÂµÒ¢f–æÆÇ“ ¢–b÷våö6Æ–VçC ¢v—B6Æ–VçBæ6Æ÷6R‚¢&WGW&â°¢6ö×WF—F÷$B€¢Æ–'&'•ö–C×7G"‡‚ævWB‚&–B"Â""’’À¢vUöæÖS×7G"‡‚ævWB‚'vUöæÖR"Â""’’À¢Eö6÷“Õ°¢7G"‡2•³£Òf÷"2–â‡‚ævWB‚&Eö7&VF—fUö&öF–W2"’÷"µÒ•³£EÐ¢ÒÀ¢ÆFf÷&×3Õ·7G"‡2’f÷"2–â‡‚ævWB‚'V&Æ—6†W%÷ÆFf÷&×2"’÷"µÒ•³£…ÕÒÀ¢7F'FVEöC×‚ævWB‚&EöFVÆ—fW'•÷7F'E÷F–ÖR"’À¢6æ6†÷E÷W&Ã×‚ævWB‚&E÷6æ6†÷E÷W&Â"’À¢¢f÷"‚–â&÷w5³¦Æ–Ö—EÐ¢–b‚ævWB‚&–B"¢Ð  ¦6Æ72ÖWFV&Æ—6†W# ¢""%6–ævÆR×W6RÖWFvV'6—FR×6ÆW2–Æ÷Bv—F‚(*ÃRöF’Â6WfVâÖF’ÆÆ÷væ6Rà ¢æ÷F†–ær—27V&Ö—GFVBVæÆW72E%•õ%TãÖfÇ6RÂÄÄõuôÔ”5$õô%TDtUC×G'VRÂF†RÆ—fP¢66÷VçBö76WG272&VfÆ–v‡BÂF†R6VÆV7FVB&öGV7B—2–âF†RfÆ–FFVBfVVBÀ¢F†R7&VF—fR76W2—G2VÆ—G’6†V6·2ÂæBF†RW'6—7FVçBöæR×6†÷B6Æ–Ò—0¢7V—&VBâF†RB6WBW6W2(*ÃRF–Ç’'VFvWBæB6WfVâÖF’66†VGVÆRà¢""  ¢TäEô”åBÒ&‡GG3¢òöw&‚æf6V&öö²æ6öÒ ¢D”Å•ô%TDtUEô4TåE2ÒS ¢•õdU%4”ôåõEDU$âÒ&Ræ6ö×–ÆR‡"%çeÆBµÂåÆB²B"¢”EõEDU$âÒ&Ræ6ö×–ÆR‡"%åÆG³BÃ3ÒB"¢44õTåEõEDU$âÒ&Ræ6ö×–ÆR‡"%æ7EõÆG³BÃ3ÒB" ¢FVbõö–æ—Eõò€¢6VÆbÀ¢VF—C¢ÆäVF—E7F÷&RÀ¢¢À¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÂæöæRÒæöæRÀ¢Vçc¢F–7E·7G"Â7G%ÒÂæöæRÒæöæRÀ¢“ ¢6VÆbæVF—BÒVF—@¢6VÆbæ6Æ–VçBÒ6Æ–Vç@¢6VÆbæVçbÒVçb–bVçb—2æ÷BæöæRVÇ6R÷2æVçf—&öà ¢7–æ2FVb&V6öæ6–ÆU÷&WF—&VEö6×–vâ‡6VÆb’ÓâF–7E·7G"Âç•Ó ¢""%&WF—&RF†R÷væW"w2öÆB6×–vâ–æFWVæFVçFÇ’öbÆÂ–BÖ7F–öâvFW2à ¢öæÇ’ÖWF&VG2Â–FV×÷FVçB6†–ÆBW6W2æBÆö6Â&6†—fR&RW&Ö—GFVBà¢â7F—fR÷"Væ6W'F–â&VÖ÷FR6×–vâÇv—2&WF–ç2—G2Æö6Â6Æ–Òà¢"" ¢6×–våö–BÒ###SC3#Cs“Cƒ#sB ¢6Æ–ÒÒv—B6VÆbæVF—BævWEöÖWFöÖ–7&õö6×–våö6Æ–Ò‚¢–b6Æ–Ò—2æöæR÷"6Æ–ÒævWB‚&6×–våö–B"’Ò6×–våö–C ¢&WGW&â²'7FGW2#¢&æ÷EöÆ–6&ÆR"Â&6×–våö–B#¢6×–våö–GÐ¢7FGW2Ò7G"†6Æ–ÒævWB‚'7FGW2"Â""’¢–b7FGW2æ÷B–â²$5D•dUõTäD”äuõ$Ud”Ur"Â%$T4ôä4”ÄTEôU„•5D”äuô4Õ”tâ'Ó ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢%$UD•$TEô4Õ”tåõTäU…T5DTEô4Ä”Õõ5DDR'Ð¢Fö¶VâÒ6VÆbæVçbævWB‚$ÔUDô44U55õDô´Tâ"Â""’ç7G&—‚¢–bæ÷BFö¶Vã ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDô44U55õDô´TåôÔ•54”är'Ð¢÷våö6Æ–VçBÒ6VÆbæ6Æ–VçB—2æöæP¢6Æ–VçBÒ6VÆbæ6Æ–VçB÷"‡GG‚ä7–æ46Æ–VçB‡F–ÖV÷WCÓ3RÂföÆÆ÷u÷&VF—&V7G3ÔfÇ6R¢G'“ ¢&W7VÇBÒv—B6VÆbå÷&V6öæ6–ÆU÷W6VEö6×–vâ€¢6Æ–VçBÂ²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'ÒÂ6×–våö–@¢¢–b&W7VÇBÓÒ&G6WG5öæ÷EöÆÅ÷W6VB# ¢2F†R&VçB—2Ç&VG’U4TBâf–æ—6‚&WF—&–æröæÇ’—G26†–ÆG&Vã°¢2æWfW"7F—fFR÷"6†ævR'VFvWBÂ7&VF—fRÂ÷"æ÷F†W"6×–vâà¢G6WG2Òv—B6VÆbåövWB€¢6Æ–VçBÂb'¶6×–våö–GÒöG6WG2"Â²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'ÒÀ¢²&f–VÆG2#¢&–BÇ7FGW2"Â&Æ–Ö—B#¢#'ÒÀ¢¢&÷w2ÒG6WG2ævWB‚&FF"¢v–ærÒG6WG2ævWB‚'v–ær"¢–b†æ÷B—6–ç7Fæ6R‡&÷w2ÂÆ—7B¢÷"†—6–ç7Fæ6R‡v–ærÂF–7B’æBv–ærævWB‚&æW‡B"’¢÷"ç’†æ÷B—6–ç7Fæ6R‡&÷rÂF–7B¢÷"æ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡7G"‡&÷rævWB‚&–B"Â""’’¢f÷"&÷r–â&÷w2’“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢&G6WG5ö–æ6ö×ÆWFR'Ð¢f÷"&÷r–â&÷w3 ¢–b7G"‡&÷rævWB‚'7FGW2"Â""’’çWW"‚’ÓÒ$5D•dR# ¢&W7öç6RÒv—B6Æ–VçBç÷7B€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷·&÷u²v–Bu×Ò"À¢†VFW'3×²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'ÒÀ¢FF×²'7FGW2#¢%U4TB'ÒÀ¢¢6VÆbåö§6öå÷&W7öç6R‡&W7öç6RÂ&WV—&Uöö&¦V7Eö–CÔfÇ6R¢&W7VÇBÒv—B6VÆbå÷&V6öæ6–ÆU÷W6VEö6×–vâ€¢6Æ–VçBÂ²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'ÒÂ6×–våö–@¢¢–b&W7VÇBÒ'&VG’# ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢&W7VÇBÂ&6×–våö–B#¢6×–våö–GÐ¢&VÆV6VBÒv—B6VÆbæVF—Bç&VÆV6Uö–æ7F—fUö6Æ–Ò€¢6×–våö–CÖ6×–våö–BÂW‡V7FVE÷7FGW3×7FGW0¢¢&WGW&â²'7FGW2#¢$”ä5D•dR"–b&VÆV6VBVÇ6R&6Æ–Õö6†ævVB"À¢&6×–våö–B#¢6×–våö–GÐ¢f–æÆÇ“ ¢–b÷våö6Æ–VçC ¢v—B6Æ–VçBæ6Æ÷6R‚ ¢7–æ2FVb6†V6µ÷&VF–æW72‡6VÆb’ÓâF–7E·7G"Âç•Ó ¢""%&VBÖWF66÷VçBÂvRæB—†VÂ66W72v—F†÷WB7&VF–ærBö&¦V7G2à ¢F†—2FVÆ–&W&FVÇ’FöW2æ÷B&WV—&RF†R7VæB7v—F6†W2ÂE4Æ&VÇ2Â&–ÆÆ–æp¢6öæf—&ÖF–öâ÷"W&6†6RÖWfVçB6öæf—&ÖF–öââF†÷6R&RWfÇVFVB'’F†P¢6W&FRÖ–7&òÖ'VFvWBvFR&Vf÷&Rç’6×–vâw&—FRà¢"" ¢&WV—&VBÒ°¢$ÔUDô44U55õDô´Tâ#¢6VÆbæVçbævWB‚$ÔUDô44U55õDô´Tâ"Â""’ç7G&—‚’À¢$ÔUDôEô44õTåEô”B#¢6VÆbæVçbævWB‚$ÔUDôEô44õTåEô”B"Â""’ç7G&—‚’À¢$ÔUDõ•„TÅô”B#¢6VÆbæVçbævWB‚$ÔUDõ•„TÅô”B"Â""’ç7G&—‚’À¢$ÔUDõtUô”B#¢6VÆbæVçbævWB‚$ÔUDõtUô”B"Â""’ç7G&—‚’À¢Ð¢Ö—76–ærÒ¶æÖRf÷"æÖRÂfÇVR–â&WV—&VBæ—FV×2‚’–bæ÷BfÇVUÐ¢–bÖ—76–æs ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â&Ö—76–ær#¢Ö—76–æwÐ¢66÷VçEö–BÒ&WV—&VE²$ÔUDôEô44õTåEô”B%Ð¢vUö–BÒ&WV—&VE²$ÔUDõtUô”B%Ð¢—†VÅö–BÒ&WV—&VE²$ÔUDõ•„TÅô”B%Ð¢–bæ÷B6VÆbä44õTåEõEDU$âægVÆÆÖF6‚†66÷VçEö–B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDôEô44õTåEô”Eô”ådÄ”B'Ð¢–bæ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡—†VÅö–B’÷"æ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡vUö–B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDõ•„TÅôõ%õtUô”Eô”ådÄ”B'Ð ¢÷våö6Æ–VçBÒ6VÆbæ6Æ–VçB—2æöæP¢6Æ–VçBÒ6VÆbæ6Æ–VçB÷"‡GG‚ä7–æ46Æ–VçB€¢F–ÖV÷WCÖ‡GG‚åF–ÖV÷WBƒ3Â6öææV7CÓ‚’ÂföÆÆ÷u÷&VF—&V7G3ÔfÇ6P¢¢G'“ ¢&VF–æW72Òv—B6VÆbå÷&VfÆ–v‡B€¢6Æ–VçBÀ¢†VFW'3×²$WF†÷&—¦F–öâ#¢b$&V&W"·&WV—&VE²tÔUDô44U55õDô´Tâu×Ò'ÒÀ¢66÷VçEö–CÖ66÷VçEö–BÀ¢vUö–C×vUö–BÀ¢—†VÅö–C×—†VÅö–BÀ¢¢&WGW&â²'7FGW2#¢&6†V6¶VB"Â&66÷VçB#¢&VF–æW72æÖöFVÅöGV×†ÖöFSÒ&§6öâ"—Ð¢W†6WB7–æ6–òä6æ6VÆÆVDW'&÷# ¢&—6P¢W†6WB‡GG‚ä…EE7FGW4W'&÷"2W†3 ¢&W7öç6RÒW†2ç&W7öç6P¢G'“ ¢&öG’Ò&W7öç6Ræ§6öâ‚¢W†6WBfÇVTW'&÷# ¢&öG’Ò·Ð¢W'&÷"Ò&öG’ævWB‚&W'&÷""Â·Ò’–b—6–ç7Fæ6R†&öG’ÂF–7B’VÇ6R·Ð¢–bæ÷B—6–ç7Fæ6R†W'&÷"ÂF–7B“ ¢W'&÷"Ò·Ð¢F–ÂÒW&Ç7Æ—B‡7G"†W†2ç&WVW7BçW&Â’’çF‚ç'7G&—‚"ò"’ç'7Æ—B‚"ò"Â•²ÓÐ¢7FvRÒ€¢'—†VÂ ¢–bF–ÂÓÒ&G7—†VÇ2 ¢VÇ6R&66÷VçB ¢–bF–ÂÓÒ66÷VçEö–@¢VÇ6R'vR ¢¢FWF–Ç3¢F–7E·7G"Âç•ÒÒ°¢'7FGW2#¢&f–ÆVB"À¢&W'&÷%÷G—R#¢$ÖWF…EEW'&÷""À¢&‡GG÷7FGW2#¢&W7öç6Rç7FGW5ö6öFRÀ¢'7FvR#¢7FvRÀ¢Ð¢f÷"6÷W&6RÂF&vWB–â€¢‚&6öFR"Â&ÖWFöW'&÷%ö6öFR"’À¢‚&W'&÷%÷7V&6öFR"Â&ÖWFöW'&÷%÷7V&6öFR"’À¢“ ¢fÇVRÒW'&÷"ævWB‡6÷W&6R¢–b—6–ç7Fæ6R‡fÇVRÂ–çB“ ¢FWF–Ç5·F&vWEÒÒfÇVP¢W'&÷%÷G—RÒW'&÷"ævWB‚'G—R"¢–b—6–ç7Fæ6R†W'&÷%÷G—RÂ7G"“ ¢FWF–Ç5²&ÖWFöW'&÷%÷G—R%ÒÒW'&÷%÷G—U³£ƒÐ¢&WGW&âFWF–Ç0¢W†6WBW†6WF–öâ2W†3 ¢2&÷f–FW"&öF–W2æB&WVW7B†VFW'2Ö’6öçF–â6Vç6—F—fRFFà¢&WGW&â²'7FGW2#¢&f–ÆVB"Â&W'&÷%÷G—R#¢G—R†W†2’åõöæÖUõ÷Ð¢f–æÆÇ“ ¢–b÷våö6Æ–VçC ¢v—B6Æ–VçBæ6Æ÷6R‚ ¢7–æ2FVb6†V6µö6FÆöuö66W72‡6VÆb’ÓâF–7E·7G"Âç•Ó ¢""%&VB6FÆöræBv†öÆRÖ6FÆör&öGV7B×6WB66W73²æWfW"w&—FW2ÖWFö&¦V7G2â"" ¢Fö¶VâÒ6VÆbæVçbævWB‚$ÔUDô44U55õDô´Tâ"Â""’ç7G&—‚¢6FÆöuö–BÒ6VÆbæVçbævWB‚$ÔUDõ$ôET5Eô4DÄôuô”B"Â""’ç7G&—‚¢fW'6–öâÒ6VÆbå÷fW'6–öâ‚¢–bæ÷BFö¶Vã ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDô44U55õDô´TåôÔ•54”är'Ð¢–bæ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚†6FÆöuö–B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDõ$ôET5Eô4DÄôuô”EôÔ•54”äuôõ%ô”ådÄ”B'Ð¢–bæ÷B6VÆbä•õdU%4”ôåõEDU$âægVÆÆÖF6‚‡fW'6–öâ“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDô•õdU%4”ôåô”ådÄ”B'Ð ¢÷våö6Æ–VçBÒ6VÆbæ6Æ–VçB—2æöæP¢6Æ–VçBÒ6VÆbæ6Æ–VçB÷"‡GG‚ä7–æ46Æ–VçB€¢F–ÖV÷WCÖ‡GG‚åF–ÖV÷WBƒ3Â6öææV7CÓ‚’ÂföÆÆ÷u÷&VF—&V7G3ÔfÇ6P¢¢†VFW'2Ò²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'Ð¢G'“ ¢6FÆörÒv—B6VÆbåövWB€¢6Æ–VçBÂ6FÆöuö–BÂ†VFW'2Â²&f–VÆG2#¢&–BÆæÖR'Ð¢¢–b7G"†6FÆörævWB‚&–B"Â""’’Ò6FÆöuö–C ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDô4DÄôuô”EôÔ•4ÔD4‚'Ð ¢&W7VÇBÒv—B6VÆbåövWB€¢6Æ–VçBÀ¢b'¶6FÆöuö–GÒ÷&öGV7E÷6WG2"À¢†VFW'2À¢²&f–VÆG2#¢&–BÆæÖR"Â&Æ–Ö—B#¢#'ÒÀ¢¢&÷w2Ò&W7VÇBævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R‡&÷w2ÂÆ—7B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDõ$ôET5Eõ4UEôÄ•5Eô”ådÄ”B'Ð¢–b—6–ç7Fæ6R‡&W7VÇBævWB‚'v–ær"’ÂF–7B’æB&W7VÇE²'v–ær%ÒævWB‚&æW‡B"“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDõ$ôET5Eõ4UEôÄ•5Eô”ä4ôÕÄUDR'Ð ¢gVÆÅö6FÆöuöæÖW2Ò²&ÆÂ&öGV7G2"Â&ÆÆR&öGV·FR'Ð¢gVÆÅ÷6WG2Ò°¢&÷rf÷"&÷r–â&÷w0¢–b—6–ç7Fæ6R‡&÷rÂF–7B¢æB7G"‡&÷rævWB‚&æÖR"Â""’’ç7G&—‚’æ66VföÆB‚’–âgVÆÅö6FÆöuöæÖW0¢æB6VÆbä”EõEDU$âægVÆÆÖF6‚‡7G"‡&÷rævWB‚&–B"Â""’’¢Ð¢6öæf–wW&VE÷6WEö–BÒ6VÆbæVçbævWB‚$ÔUDõ$ôET5Eõ4UEô”B"Â""’ç7G&—‚¢–b6öæf–wW&VE÷6WEö–C ¢–bæ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚†6öæf–wW&VE÷6WEö–B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÔUDõ$ôET5Eõ4UEô”Eô”ådÄ”B'Ð¢6VÆV7FVBÒ°¢&÷rf÷"&÷r–âgVÆÅ÷6WG0¢–b7G"‡&÷rævWB‚&–B"’’ÓÒ6öæf–wW&VE÷6WEö–@¢Ð¢–bÆVâ‡6VÆV7FVB’Ò ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢$ÔUDô4ôäd”uU$TEõ4UEô•5ôäõEôÄÅõ$ôET5E2"À¢&6FÆöuö–B#¢6FÆöuö–BÀ¢Ð¢gVÆÅ÷6WBÒ6VÆV7FVE³Ð¢VÆ–bÆVâ†gVÆÅ÷6WG2’ÓÒ ¢gVÆÅ÷6WBÒgVÆÅ÷6WG5³Ð¢VÇ6S ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢$ÔUDôÄÅõ$ôET5E5õ4UEôäõEôdõTäEôõ%ôÔ$”uTõU2"À¢&6FÆöuö–B#¢6FÆöuö–BÀ¢&ÖF6†–æu÷6WEö6÷VçB#¢ÆVâ†gVÆÅ÷6WG2’À¢Ð ¢&WGW&â°¢'7FGW2#¢&6†V6¶VB"À¢&6FÆöuö–B#¢6FÆöuö–BÀ¢&6FÆöuöæÖR#¢7G"†6FÆörævWB‚&æÖR"Â""’•³£cÒÀ¢'&öGV7E÷6WEö–B#¢7G"†gVÆÅ÷6WE²&–B%Ò’À¢'&öGV7E÷6WEöæÖR#¢7G"†gVÆÅ÷6WBævWB‚&æÖR"Â""’•³£ƒÒÀ¢'f—6–&ÆU÷&öGV7E÷6WEö6÷VçB#¢ÆVâ‡&÷w2’À¢&6×–vå÷w&—FW5÷W&f÷&ÖVB#¢fÇ6RÀ¢Ð¢W†6WB7–æ6–òä6æ6VÆÆVDW'&÷# ¢&—6P¢W†6WB‡GG‚ä…EE7FGW4W'&÷"2W†3 ¢G'“ ¢&öG’ÒW†2ç&W7öç6Ræ§6öâ‚¢W†6WBfÇVTW'&÷# ¢&öG’Ò·Ð¢W'&÷"Ò&öG’ævWB‚&W'&÷""Â·Ò’–b—6–ç7Fæ6R†&öG’ÂF–7B’VÇ6R·Ð¢–bæ÷B—6–ç7Fæ6R†W'&÷"ÂF–7B“ ¢W'&÷"Ò·Ð¢FWF–Ç3¢F–7E·7G"Âç•ÒÒ°¢'7FGW2#¢&f–ÆVB"À¢'&V6öâ#¢$ÔUDô4DÄôuõ$TEôd”ÄTB"À¢&‡GG÷7FGW2#¢W†2ç&W7öç6Rç7FGW5ö6öFRÀ¢&6×–vå÷w&—FW5÷W&f÷&ÖVB#¢fÇ6RÀ¢Ð¢f÷"6÷W&6RÂF&vWB–â€¢‚&6öFR"Â&ÖWFöW'&÷%ö6öFR"’À¢‚&W'&÷%÷7V&6öFR"Â&ÖWFöW'&÷%÷7V&6öFR"’À¢“ ¢fÇVRÒW'&÷"ævWB‡6÷W&6R¢–b—6–ç7Fæ6R‡fÇVRÂ–çB“ ¢FWF–Ç5·F&vWEÒÒfÇVP¢–b—6–ç7Fæ6R†W'&÷"ævWB‚'G—R"’Â7G"“ ¢FWF–Ç5²&ÖWFöW'&÷%÷G—R%ÒÒW'&÷%²'G—R%Õ³£ƒÐ¢&WGW&âFWF–Ç0¢W†6WBW†6WF–öâ2W†3 ¢2æWfW"–æ6ÇVFR&÷f–FW"&W7öç6R&öF–W2Â†VFW'2Â÷"7&VFVçF–Ç2–âÆöw2à¢&WGW&â°¢'7FGW2#¢&f–ÆVB"À¢'&V6öâ#¢$ÔUDô4DÄôuõ$TEôd”ÄTB"À¢&W'&÷%÷G—R#¢G—R†W†2’åõöæÖUõòÀ¢&6×–vå÷w&—FW5÷W&f÷&ÖVB#¢fÇ6RÀ¢Ð¢f–æÆÇ“ ¢–b÷våö6Æ–VçC ¢v—B6Æ–VçBæ6Æ÷6R‚ ¢7–æ2FVbV&Æ—6…ööæR€¢6VÆbÀ¢¢À¢7&VF—fS¢vVæW&FVD7&VF—fRÂæöæRÀ¢&öGV7C¢F–7E·7G"Âç•ÒÀ¢&öGV7Eö–G5ö–åöfVVC¢6WE·7G%ÒÀ¢&öGV7G3¢Æ—7E¶F–7E·7G"Âç•ÕÒÂæöæRÒæöæRÀ¢’ÓâF–7E·7G"Âç•Ó ¢6öæf–rÒ6VÆbåö6öæf–wW&F–öâ‚¢–b—6–ç7Fæ6R†6öæf–rÂF–7B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â¢¦6öæf–wÐ¢g&öÒçW&6†6UöwV&B–×÷'BW&6†6TWf–FVæ6RÂ&WV—&W5÷&V6VçE÷W&6†6P ¢Wf–FVæ6RÒv—BW&6†6TWf–FVæ6R†Vçc×6VÆbæVçbÂ6Æ–VçC×6VÆbæ6Æ–VçB’æ6†V6²‚¢–b&WV—&W5÷&V6VçE÷W&6†6R‡6VÆbæVçb’æBæ÷BWf–FVæ6U²'fW&–f–VB%Ó ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$e$U4…õU$4„4Uõ$UT•$TB"Â'W&6†6R#¢Wf–FVæ6WÐ¢66÷VçEö–BÂvUö–BÂ—†VÅö–BÂFö¶VâÂfW'6–öâÂ&VæVf–6–'’Â–÷"Â6FÆöuö–BÂ&öGV7E÷6WEö–BÒ6öæf–p¢vV'6—FUöÖöFRÒ6VÆbæVçbævWB‚%”ÄõEôEôÔôDR"Â&6FÆör"’ÓÒ'vV'6—FU÷6ÆW2 ¢7F÷'’ÒæöæP¢GfW'F—6VEö–G3¢Æ—7E·7G%ÒÒµÐ¢–bvV'6—FUöÖöFS ¢g&öÒçvV'6—FUöG2–×÷'BvV'6—FU÷7F÷' ¢G'“ ¢7F÷'’ÂGfW'F—6VEö–G2ÒvV'6—FU÷7F÷'’‡&öGV7G2÷"·&öGV7EÒÂvUö–B¢W†6WBfÇVTW'&÷"2W†3 ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢7G"†W†2—Ð¢–bæ÷B6WB†GfW'F—6VEö–G2’æ—77V'6WB‡&öGV7Eö–G5ö–åöfVVB“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢%$ôET5EôäõEô”åõdÄ”DDTEôdTTB'Ð¢&öGV7Eö–BÒ7G"‡&öGV7BævWB‚&–B"Â""’¢26FÆör—FV×27WÇ’F†V—"÷vâ–ÖvW2æBFW7F–æF–öâU$Ç2à¢Æ–æ²Ò7G"‡&öGV7BævWB‚&Æ–æ²"Â""’¢'6VEöÆ–æ²ÒW&Ç7Æ—B†Æ–æ²¢–b€¢'6VEöÆ–æ²ç66†VÖRÒ&‡GG2 ¢÷"'6VEöÆ–æ²æ†÷7FæÖRæ÷B–â²&†öÖW7G&òæFR"Â'wwræ†öÖW7G&òæFR'Ð¢÷"'6VEöÆ–æ²çW6W&æÖP¢÷"'6VEöÆ–æ²ç77v÷&@¢“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢%$ôET5EõU$ÅôäõEôÄÄõtTB'Ð¢–b&öGV7Eö–Bæ÷B–â&öGV7Eö–G5ö–åöfVVC ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢%$ôET5EôäõEô”åõdÄ”DDTEôdTTB'Ð¢÷våö6Æ–VçBÒ6VÆbæ6Æ–VçB—2æöæP¢6Æ–VçBÒ6VÆbæ6Æ–VçB÷"‡GG‚ä7–æ46Æ–VçB€¢F–ÖV÷WCÖ‡GG‚åF–ÖV÷WBƒ3RÂ6öææV7CÓ‚’ÂföÆÆ÷u÷&VF—&V7G3ÔfÇ6P¢¢†VFW'2Ò²$WF†÷&—¦F–öâ#¢b$&V&W"·Fö¶VçÒ'Ð¢7&VFVEö–G3¢F–7E·7G"Â7G%ÒÒ·Ð¢6Æ–Õö7V—&VBÒfÇ6P¢&W7VÖVEö6×–vã¢7G"ÂæöæRÒæöæP¢G'“ ¢–bæ÷BvV'6—FUöÖöFRæBæ÷B&öGV7E÷6WEö–C ¢&W6öÇfVE÷6WEö–BÒv—B6VÆbå÷&W6öÇfUöÆÅ÷&öGV7G5÷6WB€¢6Æ–VçBÂ6FÆöuö–BÂ†VFW'0¢¢–bæ÷B&W6öÇfVE÷6WEö–C ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢$ÔUDôÄÅõ$ôET5E5õ4UEôäõEôdõTäEôõ%ôÔ$”uTõU2"À¢'&öGV7Eö6FÆöuö–B#¢6FÆöuö–BÀ¢Ð¢&öGV7E÷6WEö–BÒ&W6öÇfVE÷6WEö–@¢&–÷%ö6Æ–ÒÒv—B6VÆbæVF—BævWEöÖWFöÖ–7&õö6×–våö6Æ–Ò‚¢–b&–÷%ö6Æ–Ò—2æ÷BæöæS ¢–b€¢&–÷%ö6Æ–Õ²'7FGW2%ÒÓÒ$d”ÄTEô…EE7FGW4W'&÷" ¢æB&–÷%ö6Æ–Õ²&6×–våö–B%Ò—2æöæP¢“ ¢&V6öæ6–Æ–F–öâÒv—B6VÆbå÷&V6öæ6–ÆUöf–ÆVEö6Æ–Ò€¢6Æ–VçBÂ66÷VçEö–BÂ†VFW'2Â&öGV7Eö–@¢¢–b&V6öæ6–Æ–F–öâÓÒ&æ÷Eöf÷VæB# ¢&VÆV6VBÒv—B6VÆbæVF—Bç&VÆV6Uöf–ÆVEö6Æ–Õ÷v—F†÷WEö6×–vâ‚¢–bæ÷B&VÆV6VC ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ôäUô4Õ”tåôÄÄõtä4UôÅ$TE•ô4Ä”ÔTB'Ð¢v—B6VÆbæVF—Bç&V6÷&B€¢&ÖWFöÖ–7&õö6×–våö6Æ–Õ÷&VÆV6VB"À¢²'&V6öâ#¢$ÖWF6öæf—&ÖVBæò6×–vâW†—7G2"Â'&öGV7Eö–B#¢&öGV7Eö–GÒÀ¢¢VÇ6S ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢€¢%$”õ%ôÔUDô4Õ”tåôdõTäB ¢–b&V6öæ6–Æ–F–öâÓÒ&f÷VæB ¢VÇ6R%$”õ%ô4Õ”tåõ$T4ôä4”Ä”D”ôåô”ä4ôÕÄUDR ¢’À¢Ð¢VÆ–b€¢&–÷%ö6Æ–Õ²'7FGW2%ÒÓÒ$d”ÄTEô…EE7FGW4W'&÷" ¢æB&–÷%ö6Æ–Õ²&6×–våö–B%Ò—2æ÷BæöæP¢“ ¢&W7VÖVEö6×–vâÒ7G"‡&–÷%ö6Æ–Õ²&6×–våö–B%Ò¢&V6öæ6–Æ–F–öâÒv—B6VÆbå÷&V6öæ6–ÆU÷W6VEö6×–vâ€¢6Æ–VçBÂ†VFW'2Â&W7VÖVEö6×–và¢¢–b&V6öæ6–Æ–F–öâÒ'&VG’# ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢%$”õ%ô4Õ”tåôäõEõ4dUõDõõ$U5TÔR"À¢&6×–våö–B#¢&W7VÖVEö6×–vâÀ¢'&V6öæ6–Æ–F–öâ#¢&V6öæ6–Æ–F–öâÀ¢Ð¢VÆ–b€¢&–÷%ö6Æ–Õ²&6×–våö–B%Ð¢æB&–÷%ö6Æ–Õ²'7FGW2%Ð¢–â²$5D•dUõTäD”äuõ$Ud”Ur"Â%$T4ôä4”ÄTEôU„•5D”äuô4Õ”tâ'Ð¢“ ¢2¶VW–FVçF—G’F‡&÷Vv‚vF6†FörW6W3²æWfW"&V7&VFR—Bà¢&WGW&â²'7FGW2#¢&W†—7F–æuö6×–vâ"Â&6×–våö–B#¢&–÷%ö6Æ–Õ²&6×–våö–B%ÒÀ¢'&V6öâ#¢$U„•5D”äuô4Õ”tåõ$UD”äTEôäõôEUÄ”4DR'Ð¢VÇ6S ¢&WGW&â°¢'7FGW2#¢&&Æö6¶VB"À¢'&V6öâ#¢$ôäUô4Õ”tåôÄÄõtä4UôÅ$TE•ô4Ä”ÔTB"À¢&6×–våö–B#¢&–÷%ö6Æ–Õ²&6×–våö–B%ÒÀ¢&6Æ–Õ÷7FGW2#¢&–÷%ö6Æ–Õ²'7FGW2%ÒÀ¢Ð ¢&VF–æW72Òv—B6VÆbå÷&VfÆ–v‡B€¢6Æ–VçBÀ¢†VFW'3Ö†VFW'2À¢66÷VçEö–CÖ66÷VçEö–BÀ¢vUö–C×vUö–BÀ¢—†VÅö–C×—†VÅö–BÀ¢¢vFRÒÖ–7&ô'VFvWDvFR†Væ&ÆVCÕG'VR’æWfÇVFR€¢66÷VçC×&VF–æW72À¢W&6†6UöWfVçE÷fW&–f–VC×6VÆbæVçbævWB‚$ÔUDõU$4„4UôUdTåEõdU$”d”TB"Â&fÇ6R"’æÆ÷vW"‚’ÓÒ'G'VR"À¢VçfW&–f–VEöÖV7W&VÖVçE÷FW7EöWF†÷&—¦VCÖÖV7W&VÖVçE÷&—6µö66WFVB‡6VÆbæVçb’À¢&öGV7Eö–G5ö–åöfVVC×&öGV7Eö–G5ö–åöfVVBÀ¢&Wf–÷W6Ç•÷7V&Ö—GFVEö6×–vç3ÓÀ¢G'•÷'VãÔfÇ6RÀ¢¢–bæ÷BvFRæVÆ–v–&ÆS ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$Ô”5$õô%TDtUEõ$TdÄ”t…Eôd”ÄTB"Â&&Æö6¶W'2#¢vFRæ&Æö6¶W'7Ð¢6Æ–Õö7V—&VBÒG'VP¢–b&W7VÖVEö6×–vâ—2æöæS ¢–bæ÷Bv—B6VÆbæVF—Bæ6Æ–ÕöÖWFöÖ–7&õö6×–vâ†66÷VçEö–BÂ&öGV7Eö–B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ôäUô4Õ”tåôÄÄõtä4UôÅ$TE•ô4Ä”ÔTB'Ð¢v—B6VÆbæVF—Bç&V6÷&B€¢&ÖWFöÖ–7&õö'VFvWEö6Æ–Ò"À¢°¢&66÷VçEö–B#¢66÷VçEö–BÀ¢'&öGV7Eö–B#¢&öGV7Eö–BÀ¢&F–Ç•ö'VFvWEöWW"#¢Ö–7&ô'VFvWDvFRäD”Å•ô%TDtUEôUU"À¢&Æ–fWF–ÖUö'VFvWEöWW"#¢ãÀ¢'ÆææVEöF—2#¢Ö–7&ô'VFvWDvFRåÄääTEôD•2À¢'ÆææVE÷F÷FÅöWW"#¢Ö–7&ô'VFvWDvFRåDõDÅô%TDtUEôUU"À¢ÒÀ¢¢6×–vâÒv—B6VÆbå÷÷7B€¢6Æ–VçBÀ¢b'¶66÷VçEö–GÒö6×–vç2"À¢†VFW'2À¢°¢&æÖR#¢6VÆbåö6×–våöæÖR‚’À¢&ö&¦V7F—fR#¢$õUD4ôÔUõ4ÄU2"À¢'7FGW2#¢%U4TB"À¢'7V6–ÅöEö6FVv÷&–W2#¢%µÒ"À¢&—5öG6WEö'VFvWE÷6†&–æuöVæ&ÆVB#¢&fÇ6R"À¢ÒÀ¢¢VÇ6S ¢6×–vâÒ&W7VÖVEö6×–và¢v—B6VÆbæVF—Bç&V6÷&B€¢&ÖWFöÖ–7&õö6×–vå÷&W7VÖR"À¢²&6×–våö–B#¢6×–vâÂ'&öGV7Eö–B#¢&öGV7Eö–BÂ'7FGW2#¢'W6VB'ÒÀ¢¢7&VFVEö–G5²&6×–våö–B%ÒÒ6×–và¢v—B6VÆbæVF—BçWFFUöÖWFöÖ–7&õö6×–vâ‡7FGW3Ò$4Õ”tåô5$TDTEõU4TB"Â6×–våö–CÖ6×–vâ ¢g&öÒFFWF–ÖR–×÷'BF–ÖVFVÇF ¢7F'G2ÒFFWF–ÖRææ÷r‡F–ÖW¦öæRçWF2’²F–ÖVFVÇF†Ö–çWFW3ÓR¢VæG2Ò7F'G2²F–ÖVFVÇF†F—3ÔÖ–7&ô'VFvWDvFRåÄääTEôD•2¢W†—7F–æuöG6WG2Òv—B6VÆbåövWB€¢6Æ–VçBÀ¢b'¶6×–vçÒöG6WG2"À¢†VFW'2À¢²&f–VÆG2#¢&–BÆæÖRÇ7FGW2ÆF–Ç•ö'VFvWBÆÆ–fWF–ÖUö'VFvWB"Â&Æ–Ö—B#¢#'ÒÀ¢¢W†—7F–æu÷&÷w2ÒW†—7F–æuöG6WG2ævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R†W†—7F–æu÷&÷w2ÂÆ—7B“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$E4UEõ$T4ôä4”Ä”D”ôåô”ä4ôÕÄUDR"Â&6×–våö–B#¢6×–vçÐ¢–b—6–ç7Fæ6R†W†—7F–æuöG6WG2ævWB‚'v–ær"’ÂF–7B’æBW†—7F–æuöG6WG5²'v–ær%ÒævWB‚&æW‡B"“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$E4UEõ$T4ôä4”Ä”D”ôåô”ä4ôÕÄUDR"Â&6×–våö–B#¢6×–vçÐ¢F–Ç•öG6WG2Ò°¢&÷rf÷"&÷r–âW†—7F–æu÷&÷w0¢–b—6–ç7Fæ6R‡&÷rÂF–7B’æB7G"‡&÷rævWB‚&F–Ç•ö'VFvWB"Â""’’ÓÒ7G"‡6VÆbäD”Å•ô%TDtUEô4TåE2¢Ð¢–bÆVâ†F–Ç•öG6WG2’â ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$ÕTÅD•ÄUôD”Å•ôE4UE5ôdõTäB"Â&6×–våö–B#¢6×–vçÐ¢–bF–Ç•öG6WG3 ¢W†—7F–ærÒF–Ç•öG6WG5³Ð¢–b7G"†W†—7F–ærævWB‚'7FGW2"Â""’’çWW"‚’Ò%U4TB"÷"æ÷BW†—7F–ærævWB‚&–B"“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$D”Å•ôE4UEôäõEõ4dUõDõõ$U5TÔR"Â&6×–våö–B#¢6×–vçÐ¢W†—7F–æuöG2Òv—B6VÆbåövWB€¢6Æ–VçBÂb'¶W†—7F–æu²v–Bu×ÒöG2"Â†VFW'2À¢²&f–VÆG2#¢&–BÇ7FGW2"Â&Æ–Ö—B#¢#'ÒÀ¢¢G2ÒW†—7F–æuöG2ævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R†G2ÂÆ—7B’÷"G2÷"†—6–ç7Fæ6R†W†—7F–æuöG2ævWB‚'v–ær"’ÂF–7B’æBW†—7F–æuöG5²'v–ær%ÒævWB‚&æW‡B"’“ ¢&WGW&â²'7FGW2#¢&&Æö6¶VB"Â'&V6öâ#¢$D”Å•ôE4UEôÅ$TE•ô„5ôE5ôõ%ô”ä4ôÕÄUDR"Â&6×–våö–B#¢6×–vâÂ&G6WEö–B#¢7G"†W†—7F–æu²&–B%Ò—Ð¢G6WBÒ7G"†W†—7F–æu²&–B%Ò¢v—B6VÆbæVF—Bç&V6÷&B‚&ÖWFöÖ–7&õöG6WE÷&W7VÖR"Â²&6×–våö–B#¢6×–vâÂ&G6WEö–B#¢G6WGÒ¢VÇ6S ¢G6WBÒv—B6VÆbå÷÷7B€¢6Æ–VçBÀ¢b'¶66÷VçEö–GÒöG6WG2"À¢†VFW'2À¢°¢&æÖR#¢$†öÖW7G&òDRBvV'6—FR6ÆW2"–bvV'6—FUöÖöFRVÇ6R$†öÖW7G&òDR6FÆörÆÂ&öGV7G2"À¢&6×–våö–B#¢6×–vâÀ¢&F–Ç•ö'VFvWB#¢7G"‡6VÆbäD”Å•ô%TDtUEô4TåE2’À¢&&–ÆÆ–æuöWfVçB#¢$”Õ$U54”ôå2"À¢&÷F–Ö—¦F–öåövöÂ#¢$ôde4•DUô4ôådU%4”ôå2"À¢&&–E÷7G&FVw’#¢$ÄõtU5Eô4õ5Eõt•D„õUEô4"À¢&FW7F–æF–öå÷G—R#¢%tT%4•DR"À¢'&öÖ÷FVEöö&¦V7B#¢§6öâæGV×2€¢²'—†VÅö–B#¢—†VÅö–BÂ&7W7FöÕöWfVçE÷G—R#¢%U$4„4R"À¢¢¢‡·Ò–bvV'6—FUöÖöFRVÇ6R²'&öGV7Eö6FÆöuö–B#¢6FÆöuö–GÒ—Ð¢’À¢&G6ö&VæVf–6–'’#¢&VæVf–6–'’À¢&G6÷–÷"#¢–÷"À¢'F&vWF–ær#¢§6öâæGV×2€¢°¢&vVõöÆö6F–öç2#¢²&6÷VçG&–W2#¢²$DR"Â$B%×ÒÀ¢&vUöÖ–â#¢‚À¢'V&Æ—6†W%÷ÆFf÷&×2#¢²&f6V&öö²"Â&–ç7Fw&Ò%ÒÀ¢&f6V&ööµ÷÷6—F–öç2#¢²&fVVB"Â&Ö&¶WGÆ6R"Â'7F÷'’"Â&f6V&ööµ÷&VVÇ2%ÒÀ¢&–ç7Fw&Õ÷÷6—F–öç2#¢²'7G&VÒ"Â'7F÷'’"Â'&VVÇ2%ÒÀ¢Ð¢’À¢'7F'E÷F–ÖR#¢7F'G2æ—6öf÷&ÖB‚’À¢&VæE÷F–ÖR#¢VæG2æ—6öf÷&ÖB‚’À¢'7FGW2#¢%U4TB"À¢ÒÀ¢¢7&VFVEö–G5²&G6WEö–B%ÒÒG6W@¢v—B6VÆbæVF—Bç&V6÷&B‚&ÖWFöÖ–7&õö6×–vå÷'F–Â"Â²&6×–våö–B#¢6×–vâÂ&G6WEö–B#¢G6WGÒ¢F7&VF—fRÒv—B6VÆbå÷÷7B€¢6Æ–VçBÀ¢b'¶66÷VçEö–GÒöF7&VF—fW2"À¢†VFW'2À¢‡²&æÖR#¢$†öÖW7G&òvV'6—FR7&VF—fR"Â&ö&¦V7E÷7F÷'•÷7V2#¢§6öâæGV×2‡7F÷'’ÂVç7W&Uö66–“ÔfÇ6R—Ð¢–bvV'6—FUöÖöFRVÇ6R°¢&æÖR#¢$†öÖW7G&ò6FÆör7&VF—fR"À¢'&öGV7E÷6WEö–B#¢&öGV7E÷6WEö–BÀ¢&ö&¦V7E÷7F÷'•÷7V2#¢§6öâæGV×2€¢°¢'vUö–B#¢vUö–BÀ¢'FV×ÆFUöFF#¢°¢&ÖW76vR#¢$VçFFV6¶R&öGV·FRföâ†öÖW7G&òl;Ç"FV–æVâÆÇFrâ"À¢&æÖR#¢'··&öGV7BææÖW×Ò"À¢&FW67&—F–öâ#¢'··&öGV7BæFW67&—F–öç×Ò"À¢&Æ–æ²#¢&‡GG3¢òö†öÖW7G&òæFR"À¢&6ÆÅ÷Fõö7F–öâ#¢²'G—R#¢%4„õôäõr'ÒÀ¢ÒÀ¢Ð¢’À¢Ò’À¢¢BÒv—B6VÆbå÷÷7B€¢6Æ–VçBÀ¢b'¶66÷VçEö–GÒöG2"À¢†VFW'2À¢°¢&æÖR#¢$†öÖW7G&òvV'6—FR&öGV7G2"–bvV'6—FUöÖöFRVÇ6R$†öÖW7G&ò6FÆörBÆÂ&öGV7G2"À¢&G6WEö–B#¢G6WBÀ¢&7&VF—fR#¢§6öâæGV×2‡²&7&VF—fUö–B#¢F7&VF—fWÒ’À¢'7FGW2#¢%U4TB"À¢ÒÀ¢¢7&VFVEö–G2çWFFR‡²&F7&VF—fUö–B#¢F7&VF—fRÂ&Eö–B#¢GÒ¢v—B6VÆbæVF—Bç&V6÷&B‚&ÖWFöÖ–7&õö6×–vå÷'F–Â"Â7&VFVEö–G2 ¢27F—fFR6†–ÆG&Vâv†–ÆRF†R6×–vâ—27F–ÆÂW6VBÂF†Vâ÷VâF†P¢26×–vâÆ7BâöââÖ&–wV÷W2f–ÇW&RÆÂ¶æ÷vâö&¦V7G2&RW6VBà¢v—B6VÆbåö7F—fFR†6Æ–VçBÂG6WBÂ†VFW'2¢v—B6VÆbåö7F—fFR†6Æ–VçBÂBÂ†VFW'2¢v—B6VÆbåö7F—fFR†6Æ–VçBÂ6×–vâÂ†VFW'2¢v—B6VÆbæVF—BçWFFUöÖWFöÖ–7&õö6×–vâ‡7FGW3Ò$5D•dUõTäD”äuõ$Ud”Ur"Â6×–våö–CÖ6×–vâ¢&W7VÇBÒ°¢'7FGW2#¢$5D•dUõTäD”äuõ$Ud”Ur"À¢'ÆFf÷&Ò#¢&ÖWF"À¢&6×–våö–B#¢6×–vâÀ¢&G6WEö–B#¢G6WBÀ¢&Eö–B#¢BÀ¢'&öGV7E÷66÷R#¢'6†÷–g•÷vV'6—FUö6&÷W6VÂ"–bvV'6—FUöÖöFRVÇ6R&VçF—&UöÖWFö6FÆör"À¢&GfW'F—6VE÷&öGV7Eö–G2#¢GfW'F—6VEö–G2À¢'&öGV7Eö6FÆöuö–B#¢6FÆöuö–BÀ¢'&öGV7E÷6WEö–B#¢&öGV7E÷6WEö–BÀ¢&'VFvWE÷G—R#¢&F–Ç’"À¢&F–Ç•ö'VFvWEöWW"#¢Ö–7&ô'VFvWDvFRäD”Å•ô%TDtUEôUU"À¢&Æ–fWF–ÖUö'VFvWEöWW"#¢ãÀ¢'ÆææVE÷F÷FÅöWW"#¢Ö–7&ô'VFvWDvFRåDõDÅô%TDtUEôUU"À¢'66†VGVÆVE÷v–æF÷uöF—2#¢Ö–7&ô'VFvWDvFRåÄääTEôD•2À¢&G'•÷'Vâ#¢fÇ6RÀ¢&æ÷FR#¢$ÖWF&Wf–Wr×W7B&÷fRF†RC²6×–vâFöW2æ÷BwV&çFVR–×&W76–öç2÷"6ÆW2â"À¢Ð¢v—B6VÆbæVF—Bç&V6÷&B‚&ÖWFöÖ–7&õö6×–vå÷&W7VÇB"Â&W7VÇB¢&WGW&â&W7VÇ@¢W†6WB7–æ6–òä6æ6VÆÆVDW'&÷# ¢v—B6VÆbå÷W6Uö7&VFVB†6Æ–VçBÂ7&VFVEö–G2Â†VFW'2¢v—B6VÆbæVF—BçWFFUöÖWFöÖ–7&õö6×–vâ‡7FGW3Ò$4ä4TÄÄTEõU4TB"Â6×–våö–CÖ7&VFVEö–G2ævWB‚&6×–våö–B"’¢&—6P¢W†6WBW†6WF–öâ2W†3 ¢v—B6VÆbå÷W6Uö7&VFVB†6Æ–VçBÂ7&VFVEö–G2Â†VFW'2¢v—B6VÆbæVF—BçWFFUöÖWFöÖ–7&õö6×–vâ‡7FGW3Öb$d”ÄTE÷·G—R†W†2’åõöæÖUõ÷Ò"Â6×–våö–CÖ7&VFVEö–G2ævWB‚&6×–våö–B"’¢2¶VW&÷f–FW"FWF–Ç2&÷VæFVBæBæöâ×6V7&WB6òf–ÇW&R6â&RF–væ÷6VBà¢FWF–Ç3¢F–7E·7G"Âç•ÒÒ°¢'7FGW2#¢&f–ÆVEö6Æ÷6VB"À¢&W'&÷%÷G—R#¢G—R†W†2’åõöæÖUõòÀ¢&7&VFVEöö&¦V7G5÷W6VB#¢&ööÂ†7&VFVEö–G2’À¢&öæUö6×–våöÆÆ÷væ6Uö6öç7VÖVB#¢6Æ–Õö7V—&VBÀ¢Ð¢–b—6–ç7Fæ6R†W†2Â‡GG‚ä…EE7FGW4W'&÷"“ ¢&W7öç6RÒW†2ç&W7öç6P¢G'“ ¢&öG’Ò&W7öç6Ræ§6öâ‚¢W†6WBfÇVTW'&÷# ¢&öG’Ò·Ð¢W'&÷"Ò&öG’ævWB‚&W'&÷""Â·Ò’–b—6–ç7Fæ6R†&öG’ÂF–7B’VÇ6R·Ð¢–bæ÷B—6–ç7Fæ6R†W'&÷"ÂF–7B“ ¢W'&÷"Ò·Ð¢F–ÂÒW&Ç7Æ—B‡7G"†W†2ç&WVW7BçW&Â’’çF‚ç'7G&—‚"ò"’ç'7Æ—B‚"ò"Â•²ÓÐ¢FWF–Ç5²&W'&÷%÷G—R%ÒÒ$ÖWF…EEW'&÷" ¢FWF–Ç5²&‡GG÷7FGW2%ÒÒ&W7öç6Rç7FGW5ö6öFP¢FWF–Ç5²'7FvR%ÒÒ°¢&6×–vç2#¢&6×–våö7&VFR"À¢&G6WG2#¢&G6WEö7&VFR"À¢&F–ÖvW2#¢&–ÖvU÷WÆöB"À¢&F7&VF—fW2#¢&7&VF—fUö7&VFR"À¢&G2#¢&Eö7&VFR"À¢ÒævWB‡F–ÂÂ'&VfÆ–v‡Eö÷%ö7F—fF–öâ"¢f÷"6÷W&6RÂF&vWB–â€¢‚&6öFR"Â&ÖWFöW'&÷%ö6öFR"’À¢‚&W'&÷%÷7V&6öFR"Â&ÖWFöW'&÷%÷7V&6öFR"’À¢“ ¢fÇVRÒW'&÷"ævWB‡6÷W&6R¢–b—6–ç7Fæ6R‡fÇVRÂ–çB“ ¢FWF–Ç5·F&vWEÒÒfÇVP¢W'&÷%÷G—RÒW'&÷"ævWB‚'G—R"¢–b—6–ç7Fæ6R†W'&÷%÷G—RÂ7G"“ ¢FWF–Ç5²&ÖWFöW'&÷%÷G—R%ÒÒW'&÷%÷G—U³£ƒÐ¢f÷"6÷W&6RÂF&vWB–â€¢‚&W'&÷%÷W6W%÷F—FÆR"Â&ÖWFöW'&÷%÷F—FÆR"’À¢‚&W'&÷%÷W6W%ö×6r"Â&ÖWFöW'&÷%öÖW76vR"’À¢‚&ÖW76vR"Â&ÖWFöW'&÷%÷7VÖÖ'’"’À¢“ ¢fÇVRÒW'&÷"ævWB‡6÷W&6R¢–b—6–ç7Fæ6R‡fÇVRÂ7G"“ ¢FWF–Ç5·F&vWEÒÒ""æ¦ö–â‡fÇVRç7Æ—B‚’•³£#CÐ¢&WGW&âFWF–Ç0¢f–æÆÇ“ ¢–b÷våö6Æ–VçC ¢v—B6Æ–VçBæ6Æ÷6R‚ ¢7–æ2FVb÷&V6öæ6–ÆU÷W6VEö6×–vâ€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢6×–våö–C¢7G"À¢’Óâ7G# ¢""%&W7VÖRöæÇ’6öæf—&ÖVBW6VB6×–vâv—F‚æò7F—fRB6WG2â"" ¢6×–vâÒv—B6VÆbåövWB€¢6Æ–VçBÂ6×–våö–BÂ†VFW'2Â²&f–VÆG2#¢&–BÇ7FGW2'Ð¢¢–b7G"†6×–vâævWB‚&–B"Â""’’Ò6×–våö–C ¢&WGW&â&6×–våöÖ—6ÖF6‚ ¢–b7G"†6×–vâævWB‚'7FGW2"Â""’’çWW"‚’Ò%U4TB# ¢&WGW&â&6×–våöæ÷E÷W6VB ¢G6WG2Òv—B6VÆbåövWB€¢6Æ–VçBÀ¢b'¶6×–våö–GÒöG6WG2"À¢†VFW'2À¢²&f–VÆG2#¢&–BÆæÖRÇ7FGW2ÆF–Ç•ö'VFvWBÆÆ–fWF–ÖUö'VFvWB"Â&Æ–Ö—B#¢#'ÒÀ¢¢&÷w2ÒG6WG2ævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R‡&÷w2ÂÆ—7B“ ¢&WGW&â&G6WG5ö–æ6ö×ÆWFR ¢–bç’‡7G"‡&÷rævWB‚'7FGW2"Â""’’çWW"‚’Ò%U4TB"f÷"&÷r–â&÷w2–b—6–ç7Fæ6R‡&÷rÂF–7B’“ ¢&WGW&â&G6WG5öæ÷EöÆÅ÷W6VB ¢–bç’†æ÷B—6–ç7Fæ6R‡&÷rÂF–7B’f÷"&÷r–â&÷w2“ ¢&WGW&â&G6WG5ö–æ6ö×ÆWFR ¢v–ærÒG6WG2ævWB‚'v–ær"¢–b—6–ç7Fæ6R‡v–ærÂF–7B’æBv–ærævWB‚&æW‡B"“ ¢&WGW&â&G6WG5ö–æ6ö×ÆWFR ¢&WGW&â'&VG’  ¢7–æ2FVb÷&V6öæ6–ÆUöf–ÆVEö6Æ–Ò€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢66÷VçEö–C¢7G"À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢&öGV7Eö–C¢7G"À¢’Óâ7G# ¢""%&VBÖWFw26×–vâÆ—7B&Vf÷&R&VÆV6–ærâÖ&–wV÷W2Æö6Â6Æ–Òâ"" ¢&W7VÇBÒv—B6VÆbåövWB€¢6Æ–VçBÀ¢b'¶66÷VçEö–GÒö6×–vç2"À¢†VFW'2À¢²&f–VÆG2#¢&–BÆæÖRÇ7FGW2"Â&Æ–Ö—B#¢#'ÒÀ¢¢&÷w2Ò&W7VÇBævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R‡&÷w2ÂÆ—7B“ ¢&WGW&â&–æ6ö×ÆWFR ¢W‡V7FVEöæÖRÒ6VÆbåö6×–våöæÖR‚¢f÷"&÷r–â&÷w3 ¢–bæ÷B—6–ç7Fæ6R‡&÷rÂF–7B’÷"&÷rævWB‚&æÖR"’ÒW‡V7FVEöæÖS ¢6öçF–çVP¢6×–våö–BÒ7G"‡&÷rævWB‚&–B"Â""’¢–bæ÷B6×–våö–C ¢&WGW&â&–æ6ö×ÆWFR ¢v—B6VÆbæVF—BçWFFUöÖWFöÖ–7&õö6×–vâ€¢7FGW3Ò%$T4ôä4”ÄTEôU„•5D”äuô4Õ”tâ"Â6×–våö–CÖ6×–våö–@¢¢&WGW&â&f÷VæB ¢v–ærÒ&W7VÇBævWB‚'v–ær"¢–b—6–ç7Fæ6R‡v–ærÂF–7B’æBv–ærævWB‚&æW‡B"“ ¢&WGW&â&–æ6ö×ÆWFR ¢&WGW&â&æ÷Eöf÷VæB  ¢FVbö6öæf–wW&F–öâ€¢6VÆbÀ¢’ÓâGWÆU·7G"Â7G"Â7G"Â7G"Â7G"Â7G"Â7G"Â7G"Â7G%ÒÂF–7E·7G"Âç•Ó ¢–b6VÆbæVçbævWB‚u”ÄõEôÄTä4…õôÄ”5’r’ÓÒvf—'7E÷W&6†6Uö7V—6—F–öå÷FW7Bs ¢&WGW&â²w&V6öâs¢td•%5EõU$4„4Uô4ôåE$ôÄÄU%ôõtå5ôU„5EôU„•5D”äuôEôäõôäUuô4Õ”tâwÐ¢–b6VÆbæVçbævWB‚$ÄÄõuôÔ”5$õô%TDtUB"Â&fÇ6R"’æÆ÷vW"‚’Ò'G'VR# ¢&WGW&â²'&V6öâ#¢$Ô”5$õô%TDtUEôäõEôTä$ÄTB'Ð¢–bÆ—fUöG5öG'•÷'Vâ‡6VÆbæVçb“ ¢&WGW&â²'&V6öâ#¢$E%•õ%TåôTä$ÄTB'Ð¢F–Ç•ö'VFvWEöÆ–Ö—BÒ6öæf–wW&VEöF–Ç•ö'VFvWEöÆ–Ö—EöWW"‡6VÆbæVçb¢–bF–Ç•ö'VFvWEöÆ–Ö—BÂÖ–7&ô'VFvWDvFRäD”Å•ô%TDtUEôUU# ¢&WGW&â°¢'&V6öâ#¢$Ô”5$õô%TDtUEôD”Å•ôÄ”Ô•EõDôõôÄõr"À¢'&WV—&VEöF–Ç•ö'VFvWEöWW"#¢Ö–7&ô'VFvWDvFRäD”Å•ô%TDtUEôUU"À¢&6öæf–wW&VEöF–Ç•ö'VFvWEöÆ–Ö—EöWW"#¢F–Ç•ö'VFvWEöÆ–Ö—BÀ¢Ð¢–b6VÆbæVçbævWB‚$ÔUDô$”ÄÄ”äuõdU$”d”TB"Â&fÇ6R"’æÆ÷vW"‚’Ò'G'VR# ¢&WGW&â²'&V6öâ#¢$ÔUDô$”ÄÄ”äuôäõEôÔåTÄÅ•õdU$”d”TB'Ð¢–b‡6VÆbæVçbævWB‚$ÔUDõU$4„4UôUdTåEõdU$”d”TB"Â&fÇ6R"’æÆ÷vW"‚’Ò'G'VR ¢æBæ÷BÖV7W&VÖVçE÷&—6µö66WFVB‡6VÆbæVçb’“ ¢&WGW&â²'&V6öâ#¢$ÔUDõU$4„4UôUdTåEôäõEõdU$”d”TB'Ð¢Fö¶VâÒ6VÆbæVçbævWB‚$ÔUDô44U55õDô´Tâ"Â""’ç7G&—‚¢66÷VçEö–BÒ6VÆbæVçbævWB‚$ÔUDôEô44õTåEô”B"Â""’ç7G&—‚¢—†VÅö–BÒ6VÆbæVçbævWB‚$ÔUDõ•„TÅô”B"Â""’ç7G&—‚¢vUö–BÒ6VÆbæVçbævWB‚$ÔUDõtUô”B"Â""’ç7G&—‚¢&VæVf–6–'’Ò6VÆbæVçbævWB‚$ÔUDôE4ô$TäTd”4”%’"Â""’ç7G&—‚¢–÷"Ò6VÆbæVçbævWB‚$ÔUDôE4õ”õ""Â""’ç7G&—‚¢fW'6–öâÒ6VÆbæVçbævWB‚$ÔUDô•õdU%4”ôâ"Â'c#bã"’ç7G&—‚¢6FÆöuö–BÒ6VÆbæVçbævWB‚$ÔUDõ$ôET5Eô4DÄôuô”B"Â""’ç7G&—‚¢&öGV7E÷6WEö–BÒ6VÆbæVçbævWB‚$ÔUDõ$ôET5Eõ4UEô”B"Â""’ç7G&—‚¢–bæ÷BFö¶Vã ¢&WGW&â²'&V6öâ#¢$ÔUDô44U55õDô´TåôÔ•54”är'Ð¢–bæ÷B6VÆbä44õTåEõEDU$âægVÆÆÖF6‚†66÷VçEö–B“ ¢&WGW&â²'&V6öâ#¢$ÔUDôEô44õTåEô”Eô”ådÄ”B'Ð¢–bæ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡—†VÅö–B’÷"æ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡vUö–B“ ¢&WGW&â²'&V6öâ#¢$ÔUDõ•„TÅôõ%õtUô”Eô”ådÄ”B'Ð¢ÖöFRÒ6VÆbæVçbævWB‚%”ÄõEôEôÔôDR"Â&6FÆör"¢–bÖöFRæ÷B–â²&6FÆör"Â'vV'6—FU÷6ÆW2'Ó ¢&WGW&â²'&V6öâ#¢%”ÄõEôEôÔôDUô”ådÄ”B'Ð¢–bÖöFRÓÒ&6FÆör"æB†æ÷B6FÆöuö–B÷"æ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚†6FÆöuö–B’“ ¢&WGW&â²'&V6öâ#¢$ÔUDõ$ôET5Eô4DÄôuô”EôÔ•54”äuôõ%ô”ådÄ”B'Ð¢–bÖöFRÓÒ&6FÆör"æB&öGV7E÷6WEö–BæBæ÷B6VÆbä”EõEDU$âægVÆÆÖF6‚‡&öGV7E÷6WEö–B“ ¢&WGW&â²'&V6öâ#¢$ÔUDõ$ôET5Eõ4UEô”Eô”ådÄ”B'Ð¢–bÖöFRÓÒ'vV'6—FU÷6ÆW2# ¢6FÆöuö–BÒ&öGV7E÷6WEö–BÒ" ¢–bæ÷B&VæVf–6–'’÷"æ÷B–÷# ¢&WGW&â²'&V6öâ#¢$ÔUDôUUô$TäTd”4”%•ôõ%õ”U%ôÔ•54”är'Ð¢–bÆVâ†&VæVf–6–'’’â#÷"ÆVâ‡–÷"’â# ¢&WGW&â²'&V6öâ#¢$ÔUDôUUô$TäTd”4”%•ôõ%õ”U%õDôõôÄôär'Ð¢–bæ÷B6VÆbä•õdU%4”ôåõEDU$âægVÆÆÖF6‚‡fW'6–öâ“ ¢&WGW&â²'&V6öâ#¢$ÔUDô•õdU%4”ôåô”ådÄ”B'Ð¢&WGW&â66÷VçEö–BÂvUö–BÂ—†VÅö–BÂFö¶VâÂfW'6–öâÂ&VæVf–6–'’Â–÷"Â6FÆöuö–BÂ&öGV7E÷6WEö–@ ¢FVbö6×–våöæÖR‡6VÆb’Óâ7G# ¢&WGW&â‚$†öÖW7G&òvV'6—FR6ÆW2"–b6VÆbæVçbævWB‚%”ÄõEôEôÔôDR"Â&6FÆör"’ÓÒ'vV'6—FU÷6ÆW2 ¢VÇ6R$†öÖW7G&ò6FÆör6ÆW2ÆÂ&öGV7G2" ¢FVbö7&VF—fUö&÷fVB‡6VÆbÂ7&VF—fS¢vVæW&FVD7&VF—fRÂ&öGV7Eö–C¢7G"’Óâ&ööÃ ¢66÷&RÒ7&VF—fRç66÷&P¢Ö–æ–×VÕ÷66÷&RÒ–çB‡6VÆbæVçbævWB‚%”ÄõEô5$TD•dUôÔ”åõ44õ$R"Â#ƒR"’¢&WGW&â&ööÂ€¢7&VF—fRçV&Æ—6†&ÆUö6æF–FFP¢æB7&VF—fRæ'&–Vbç&öGV7Eö–BÓÒ&öGV7Eö–@¢æB66÷&RçVÆ—G•÷66÷&RãÒÖ–æ–×VÕ÷66÷&P¢æB66÷&Rç&öGV7Eöf—F†gVÀ¢æB66÷&RæÆövõ÷f—6–&ÆP¢æB66÷&RæÆ–fW7G–ÆUö&6¶w&÷Væ@¢æB66÷&Ræf7GVÅö6Æ–×5÷7W÷'FV@¢æB7&VF—fRæ76WE÷F€¢ ¢7–æ2FVb÷&VfÆ–v‡B€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢¢À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢66÷VçEö–C¢7G"À¢vUö–C¢7G"À¢—†VÅö–C¢7G"À¢’ÓâÖWF66÷VçE&VF–æW73 ¢66÷VçBÒv—B6VÆbåövWB†6Æ–VçBÂ66÷VçEö–BÂ†VFW'2Â²&f–VÆG2#¢&–BÆ66÷VçE÷7FGW2Æ7W'&Væ7’ÆF—6&ÆU÷&V6öâ'Ò¢W‡V7FVEö66÷VçBÒ66÷VçEö–Bç&VÖ÷fW&Vf—‚‚&7Eò"¢&WGW&æVEö66÷VçBÒ7G"†66÷VçBævWB‚&–B"Â""’’ç&VÖ÷fW&Vf—‚‚&7Eò"¢G'“ ¢7F—fRÒ€¢&WGW&æVEö66÷VçBÓÒW‡V7FVEö66÷Vç@¢æB–çB‡7G"†66÷VçBævWB‚&66÷VçE÷7FGW2"Â""’’’ÓÒ¢æBæ÷B66÷VçBævWB‚&F—6&ÆU÷&V6öâ"¢¢W†6WB…G—TW'&÷"ÂfÇVTW'&÷"“ ¢7F—fRÒfÇ6P¢—†VÇ2Òv—B6VÆbåövWB†6Æ–VçBÂb'¶66÷VçEö–GÒöG7—†VÇ2"Â†VFW'2Â²&f–VÆG2#¢&–BÆæÖRÆ—5÷Væf–Æ&ÆR'Ò¢66W76–&ÆU÷—†VÂÒç’€¢7G"‡&÷rævWB‚&–B"’’ÓÒ—†VÅö–BæBæ÷B&÷rævWB‚&—5÷Væf–Æ&ÆR"¢f÷"&÷r–â—†VÇ2ævWB‚&FF"ÂµÒ¢¢vRÒv—B6VÆbåövWB†6Æ–VçBÂvUö–BÂ†VFW'2Â²&f–VÆG2#¢&–BÆæÖR'Ò¢–b7G"‡vRævWB‚&–B"Â""’’ÒvUö–C ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’&WGW&æVBF–ffW&VçBvR”B"¢&WGW&âÖWF66÷VçE&VF–æW72€¢66÷VçEö–CÖ66÷VçEö–BÀ¢66÷VçE÷7FGW3Ò&7F—fR"–b7F—fRVÇ6R&F—6&ÆVB"À¢7W'&Væ7“×7G"†66÷VçBævWB‚&7W'&Væ7’"Â""’’çWW"‚’À¢&–ÆÆ–æu÷&VG“×6VÆbæVçbævWB‚$ÔUDô$”ÄÄ”äuõdU$”d”TB"Â&fÇ6R"’æÆ÷vW"‚’ÓÒ'G'VR"À¢vUö–C×vUö–BÀ¢—†VÅö–C×—†VÅö–BÀ¢2&–÷"WfVçB—2æ÷B&WV—&VBFò7F'B6öÆB×7F'B6×–vâà¢26öæf—&Ò—†VÂ66W73²÷F–Ö—¦Rf÷"7FæF&BFEFô6'BWfVçG2à¢22f—6—F÷'2FB&öGV7G2Fò6'Bà¢—†VÅö66W75÷fW&–f–VCÖ66W76–&ÆU÷—†VÂÀ¢ ¢7–æ2FVb÷&W6öÇfUöÆÅ÷&öGV7G5÷6WB€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢6FÆöuö–C¢7G"À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢’Óâ7G"ÂæöæS ¢""%&VBæB6VÆV7BâW†—7F–ærv†öÆRÖ6FÆör&öGV7B6WC²æWfW"7&VFRöæRâ"" ¢&W7VÇBÒv—B6VÆbåövWB€¢6Æ–VçBÀ¢b'¶6FÆöuö–GÒ÷&öGV7E÷6WG2"À¢†VFW'2À¢²&f–VÆG2#¢&–BÆæÖR"Â&Æ–Ö—B#¢#'ÒÀ¢¢&÷w2Ò&W7VÇBævWB‚&FF"¢–bæ÷B—6–ç7Fæ6R‡&÷w2ÂÆ—7B“ ¢&WGW&âæöæP¢v–ærÒ&W7VÇBævWB‚'v–ær"¢–b—6–ç7Fæ6R‡v–ærÂF–7B’æBv–ærævWB‚&æW‡B"“ ¢&WGW&âæöæP¢W†7BÒ°¢&÷rf÷"&÷r–â&÷w0¢–b—6–ç7Fæ6R‡&÷rÂF–7B¢æB7G"‡&÷rævWB‚&æÖR"Â""’’ç7G&—‚’æ66VföÆB‚’–â²&ÆÂ&öGV7G2"Â&ÆÆR&öGV·FR'Ð¢æB6VÆbä”EõEDU$âægVÆÆÖF6‚‡7G"‡&÷rævWB‚&–B"Â""’’¢Ð¢2GWÆ–6FRÆ&VÂ—2æ÷B7Vff–6–VçBWf–FVæ6RF†B6WB6öçF–ç2F†P¢2–çFVæFVB6FÆör66÷Râf–Â6Æ÷6VB–ç7FVBöb6VÆV7F–æröæR'’”Bà¢–bÆVâ†W†7B’Ò ¢&WGW&âæöæP¢&WGW&â7G"†W†7E³Õ²&–B%Ò ¢7–æ2FVbövWB€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢Fƒ¢7G"À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢&×3¢F–7E·7G"Â7G%ÒÀ¢’ÓâF–7E·7G"Âç•Ó ¢&W7öç6RÒv—B6Æ–VçBævWB€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷·F‡Ò"Â†VFW'3Ö†VFW'2Â&×3×&×0¢¢&WGW&â6VÆbåö§6öå÷&W7öç6R‡&W7öç6R ¢7–æ2FVb÷÷7B€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢Fƒ¢7G"À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢FF¢F–7E·7G"Â7G%ÒÀ¢’Óâ7G# ¢&W7öç6RÒv—B6Æ–VçBç÷7B€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷·F‡Ò"Â†VFW'3Ö†VFW'2ÂFFÖFF¢¢&öG’Ò6VÆbåö§6öå÷&W7öç6R‡&W7öç6R¢ö&¦V7Eö–BÒ&öG’ævWB‚&–B"¢–bæ÷Bö&¦V7Eö–C ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’&WGW&æVBæòö&¦V7B”B"¢&WGW&â7G"†ö&¦V7Eö–B ¢7–æ2FVb÷WÆöEö–ÖvR€¢6VÆbÀ¢6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÀ¢66÷VçEö–C¢7G"À¢†VFW'3¢F–7E·7G"Â7G%ÒÀ¢–ÖvUö'—FW3¢'—FW2À¢’Óâ7G# ¢&W7öç6RÒv—B6Æ–VçBç÷7B€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷¶66÷VçEö–GÒöF–ÖvW2"À¢†VFW'3Ö†VFW'2À¢f–ÆW3×²&f–ÆVæÖR#¢‚&†öÖW7G&òÖ&÷fVBçær"Â–ÖvUö'—FW2Â&–ÖvR÷ær"—ÒÀ¢¢&öG’Ò6VÆbåö§6öå÷&W7öç6R‡&W7öç6R¢–ÖvW2Ò&öG’ævWB‚&–ÖvW2"Â·Ò¢–ÖvS¢F–7E·7G"Âç•ÒÒ€¢æW‡B†—FW"†–ÖvW2çfÇVW2‚’’Â·Ò’–b—6–ç7Fæ6R†–ÖvW2ÂF–7B’VÇ6R·Ð¢¢–bæ÷B—6–ç7Fæ6R†–ÖvRÂF–7B’÷"æ÷B–ÖvRævWB‚&†6‚"“ ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’&WGW&æVBæòWÆöFVB–ÖvR†6‚"¢&WGW&â7G"†–ÖvU²&†6‚%Ò ¢7–æ2FVbö7F—fFR€¢6VÆbÂ6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÂö&¦V7Eö–C¢7G"Â†VFW'3¢F–7E·7G"Â7G%Ð¢’ÓâæöæS ¢g&öÒçW&6†6UöwV&B–×÷'BW&6†6TWf–FVæ6RÂ&WV—&W5÷&V6VçE÷W&6†6P ¢Wf–FVæ6RÒv—BW&6†6TWf–FVæ6R†Vçc×6VÆbæVçbÂ6Æ–VçCÖ6Æ–VçB’æ6†V6²‚¢–b&WV—&W5÷&V6VçE÷W&6†6R‡6VÆbæVçb’æBæ÷BWf–FVæ6U²'fW&–f–VB%Ó ¢&—6R'VçF–ÖTW'&÷"‚$e$U4…õU$4„4Uõ$UT•$TEô$Tdõ$Uô5D•dD”ôâ"¢&W7öç6RÒv—B6Æ–VçBç÷7B€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷¶ö&¦V7Eö–GÒ"À¢†VFW'3Ö†VFW'2À¢FF×²'7FGW2#¢$5D•dR'ÒÀ¢¢6VÆbåö§6öå÷&W7öç6R‡&W7öç6RÂ&WV—&Uöö&¦V7Eö–CÔfÇ6R ¢7–æ2FVb÷W6Uö7&VFVB€¢6VÆbÂ6Æ–VçC¢‡GG‚ä7–æ46Æ–VçBÂ–G3¢F–7E·7G"Â7G%ÒÂ†VFW'3¢F–7E·7G"Â7G%Ð¢’ÓâæöæS ¢f÷"ö&¦V7Eö–B–â†–G2ævWB‚&6×–våö–B"’Â–G2ævWB‚&G6WEö–B"’Â–G2ævWB‚&Eö–B"’“ ¢–bæ÷Bö&¦V7Eö–C ¢6öçF–çVP¢G'“ ¢&W7öç6RÒv—B6Æ–VçBç÷7B€¢b'·6VÆbäTäEô”åGÒ÷·6VÆbå÷fW'6–öâ‚—Ò÷¶ö&¦V7Eö–GÒ"À¢†VFW'3Ö†VFW'2À¢FF×²'7FGW2#¢%U4TB'ÒÀ¢¢6VÆbåö§6öå÷&W7öç6R‡&W7öç6RÂ&WV—&Uöö&¦V7Eö–CÔfÇ6R¢W†6WBW†6WF–öã ¢2¶VWF†Rö&¦V7B”G2–âF†RVF—B&V6÷&Bf÷"ÖçVÂ&V6öæ6–Æ–F–öâà¢6öçF–çVP ¢FVb÷fW'6–öâ‡6VÆb’Óâ7G# ¢&WGW&â6VÆbæVçbævWB‚$ÔUDô•õdU%4”ôâ"Â'c#bã"’ç7G&—‚ ¢7FF–6ÖWF†ö@¢FVbö§6öå÷&W7öç6R€¢&W7öç6S¢‡GG‚å&W7öç6RÂ¢Â&WV—&Uöö&¦V7Eö–C¢&ööÂÒG'VP¢’ÓâF–7E·7G"Âç•Ó ¢G'“ ¢&öG’Ò&W7öç6Ræ§6öâ‚¢W†6WBfÇVTW'&÷"2W†3 ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’&WGW&æVBæöâÔ¥4ôâ&W7öç6R"’g&öÒW†0¢&W7öç6Rç&—6Uöf÷%÷7FGW2‚¢–b—6–ç7Fæ6R†&öG’ÂF–7B’æB&öG’ævWB‚&W'&÷""“ ¢W'&÷"Ò&öG•²&W'&÷"%Ð¢6öFRÒW'&÷"ævWB‚&6öFR"Â'Væ¶æ÷vâ"’–b—6–ç7Fæ6R†W'&÷"ÂF–7B’VÇ6R'Væ¶æ÷vâ ¢&—6R'VçF–ÖTW'&÷"†b$ÖWF’&V¦V7FVB&WVW7B†6öFR¶6öFWÒ’"¢–bæ÷B—6–ç7Fæ6R†&öG’ÂF–7B“ ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’&WGW&æVBâVæW‡V7FVB&W7öç6R"¢–bæ÷B&WV—&Uöö&¦V7Eö–BæB&öG’ævWB‚'7V66W72"’—2fÇ6S ¢&—6R'VçF–ÖTW'&÷"‚$ÖWF’F–Bæ÷B6öæf—&ÒF†R7FGW26†ævR"¢&WGW&â&öG  ¦7–æ2FVbWF÷–Æ÷EöÆö÷€¢¢À¢ÆöEöÖWG&–72À¢'V–ÆE÷ÆâÀ¢W†V7WF–öåöVæv–æS¢DW†V7WF–öäVæv–æRÀ¢FFW'3¢F–7EµÆFf÷&ÒÂÆFf÷&Ô×WFF–öäFFW%ÒÂæöæRÒæöæRÀ¢–çFW'fÅö†÷W'3¢–çBÒ"À¢7F÷öWfVçC¢7–æ6–òäWfVçBÂæöæRÒæöæRÀ¢öåö7–6ÆSÔæöæRÀ¢’ÓâæöæS ¢""$&÷VæFVB"Ó#F‚6W'f–6RÆö÷âÖWG&–726÷W&6R×W7B&÷f–FRGG&–'WFVBÂæ÷&ÖÆ—¦VBFFâ"" ¢–bæ÷B"ÃÒ–çFW'fÅö†÷W'2ÃÒ#C ¢&—6RfÇVTW'&÷"‚&–çFW'fÅö†÷W'2×W7B&R&WGvVVâ"æB#B"¢7F÷Ò7F÷öWfVçB÷"7–æ6–òäWfVçB‚¢v†–ÆRæ÷B7F÷æ—5÷6WB‚“ ¢G'“ ¢ÖWG&–72Â7W'&VçEö'VFvWBÒv—BÆöEöÖWG&–72‚¢ÆâÒ'V–ÆE÷Æâ€¢ÖWG&–72À¢7W'&VçE÷÷'FföÆ–õöF–Ç•ö'VFvWEöWW#Ö7W'&VçEö'VFvWBÀ¢–çFW'fÅö†÷W'3Ö–çFW'fÅö†÷W'2À¢¢&W7VÇBÒv—BW†V7WF–öåöVæv–æRæW†V7WFR‡ÆâÂFFW'2¢–böåö7–6ÆS ¢v—Böåö7–6ÆR‡ÆâÂ&W7VÇB¢W†6WB7–æ6–òä6æ6VÆÆVDW'&÷# ¢&—6P¢W†6WBW†6WF–öã ¢2&÷f–FW"æB7F÷&vRW'&÷'2&R&WG&–VBBF†RæW‡B&÷VæFVB7–6ÆRÂæWfW"–â†÷BÆö÷à¢70¢G'“ ¢v—B7–æ6–òçv—Eöf÷"‡7F÷çv—B‚’ÂF–ÖV÷WCÖ–çFW'fÅö†÷W'2¢3c¢W†6WBF–ÖV÷WDW'&÷# ¢6öçF–çVP