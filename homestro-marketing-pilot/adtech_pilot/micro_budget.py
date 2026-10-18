"""Fail-closed readiness gate for a single, capped Meta test campaign.

This module deliberately does not submit ads. Campaign creation is a multi-object
Meta API mutation and no approved publisher/account configuration is present yet.
It produces a readiness decision for an explicitly configured, verified account.
"""

from __future__ import annotations

import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MetaAccountReadiness(BaseModel):
    """Fields that must be obtained from official account/asset APIs."""

    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1)
    account_status: Literal["active", "paused", "disabled", "unknown"]
    currency: str = Field(min_length=3, max_length=3)
    billing_ready: bool
    page_id: str = Field(min_length=1)
    pixel_id: str = Field(min_length=1)
    pixel_access_verified: bool


class MicroBudgetDecision(BaseModel):
    eligible: bool
    platform: Literal["meta"] = "meta"
    daily_budget_eur: float = 0.0
    lifetime_budget_eur: float = 0.0
    planned_days: int = 5
    planned_total_eur: float = 0.0
    budget_type: Literal["lifetime"] = "lifetime"
    max_campaigns: int = 1
    product_id: str | None = None
    blockers: list[str] = Field(default_factory=list)
    live_submission_enabled: bool = False


class MicroBudgetGate:
    """Checks one campaign's readiness; never relaxes the global dry-run lock."""

    TOTAL_BUDGET_EUR = 5.0
    PLANNED_DAYS = 5

    def __init__(self, *, enabled: bool | None = None):
        if enabled is None:
            enabled = os.getenv("ALLOW_MICRO_BUDGET", "false").lower() == "true"
        self.enabled = enabled

    def evaluate(
        self,
        *,
        account: MetaAccountReadiness | None,
        product_id: str | None,
        product_ids_in_feed: set[str],
        previously_submitted_campaigns: int = 0,
        dry_run: bool = True,
    ) -> MicroBudgetDecision:
        blockers: list[str] = []
        if not self.enabled:
            blockers.append("MICRO_BUDGET_NOT_EXPLICITLY_ENABLED")
        if dry_run:
            blockers.append("DRY_RUN_ENABLED")
        if account is None:
            blockers.append("META_ACCOUNT_PREFLIGHT_NOT_VERIFIED")
        else:
            if account.account_status != "active":
                blockers.append("META_ACCOUNT_NOT_ACTIVE")
            if account.currency != "EUR":
                blockers.append("META_ACCOUNT_CURRENCY_MUST_BE_EUR")
            if not account.billing_ready:
                blockers.append("META_BILLING_NOT_READY")
            if not account.pixel_access_verified:
                blockers.append("META_PIXEL_ACCESS_NOT_VERIFIED")
        if not product_id:
            blockers.append("MICRO_BUDGET_PRODUCT_ID_MISSING")
        elif product_id not in product_ids_in_feed:
            blockers.append("MICRO_BUDGET_PRODUCT_NOT_IN_VALIDATED_FEED")
        if previously_submitted_campaigns >= 1:
            blockers.append("SINGLE_CAMPAIGN_ALLOWANCE_ALREADY_USED")

        return MicroBudgetDecision(
            eligible=not blockers,
            daily_budget_eur=0.0,
            lifetime_budget_eur=self.TOTAL_BUDGET_EUR if not blockers else 0.0,
            planned_total_eur=self.TOTAL_BUDGET_EUR if not blockers else 0.0,
            product_id=product_id,
            blockers=blockers,
            live_submission_enabled=not blockers,
        )
