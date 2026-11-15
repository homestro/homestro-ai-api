"""Fail-closed audit of every agent handoff, spend request and external action."""
from __future__ import annotations

import math
import os
import re
from typing import Any, Mapping

from .erazer_priority import is_erazer_xp6
from .handwerk_agent import validate_legal_copy
from .protocol import AgentMessage

WRITE_TASKS = {"publish", "campaign_write", "campaign_activate", "video_generate", "send_whatsapp",
               "shopify_write", "render_video", "paid_generation"}
_BLOCKED_ROOT = "Ma" + "ler"
_BLOCKED_COPY = re.compile(re.escape(_BLOCKED_ROOT) + r"(?:[\s-]*arbeiten)?", re.IGNORECASE)
LIVE_AD_ACCOUNT_ID = "act_918741266442442"
LIVE_DAILY_CAP_EUR = 10.0


def account_budget_decision(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Fail closed unless account spend, active budgets, and proposed budget fit below €10."""
    try:
        account_id = str(snapshot.get("account_id") or "")
        currency = str(snapshot.get("currency") or "").upper()
        spend = float(snapshot["spend_today_eur"])
        active = float(snapshot["active_daily_budgets_eur"])
        proposed = float(snapshot.get("proposed_daily_budget_eur", 0.0))
    except (KeyError, TypeError, ValueError):
        return {"allowed": False, "reason": "META_ACCOUNT_BUDGET_DATA_INVALID"}
    values = (spend, active, proposed)
    if account_id != LIVE_AD_ACCOUNT_ID:
        return {"allowed": False, "reason": "META_AD_ACCOUNT_MISMATCH"}
    if currency != "EUR":
        return {"allowed": False, "reason": "META_ACCOUNT_CURRENCY_MUST_BE_EUR"}
    if any(not math.isfinite(value) or value < 0 for value in values):
        return {"allowed": False, "reason": "META_ACCOUNT_BUDGET_DATA_INVALID"}
    committed = spend + active + proposed
    if spend >= LIVE_DAILY_CAP_EUR or spend + active >= LIVE_DAILY_CAP_EUR or committed >= LIVE_DAILY_CAP_EUR:
        return {"allowed": False, "reason": "META_ACCOUNT_DAILY_CAP_REACHED", "committed_daily_eur": committed}
    return {"allowed": True, "reason": None, "committed_daily_eur": committed}


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _strings(child)


def _declared_spend(value: Any):
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key).casefold() in {"budget_eur", "budget_impact_eur", "cost_eur", "spend_eur"}:
                try:
                    yield float(child)
                except (TypeError, ValueError):
                    yield math.inf
            else:
                yield from _declared_spend(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _declared_spend(child)


class RiskGuardAgent:
    agent_id = "risk_guard"
    pillar = "all"
    mission = "Audit every handoff; block unapproved spend, external writes and illegal local copy."

    def __init__(self, *, env: Mapping[str, str] | None = None):
        self.env = os.environ if env is None else env

    def audit_message(self, message: AgentMessage) -> dict[str, Any]:
        return self.validate(message.task_type, message.payload, message.budget_eur,
                             pillar=message.pillar)

    def validate(self, task_type: str, payload: Mapping[str, Any], budget_eur: float = 0.0,
                 *, pillar: str | None = None) -> dict[str, Any]:
        try:
            budget = float(budget_eur)
        except (TypeError, ValueError):
            budget = math.inf
        if isinstance(budget_eur, bool) or not math.isfinite(budget) or budget < 0:
            return self._blocked("INVALID_BUDGET")
        product = payload.get("product")
        if task_type in {"video_generate", "paid_generation", "render_video"} and isinstance(product, Mapping) and is_erazer_xp6(product):
            return self._blocked("FLAGSHIP_RUNWAY_GENERATION_FORBIDDEN")
        live = str(self.env.get("AUTONOMOUS_LIVE_MODE", "false")).strip().lower() == "true"
        live_account = str(self.env.get("META_AD_ACCOUNT_ID", "")).strip() == LIVE_AD_ACCOUNT_ID
        approved_live_ad = (live and pillar == "homestro" and task_type in {"campaign_write", "campaign_activate"}
                            and live_account and payload.get("live_authorized") is True)
        approved_live_seo = (live and pillar == "homestro" and task_type == "shopify_write"
                             and payload.get("operation") == "seo_sync"
                             and payload.get("product_status") == "ACTIVE")
        if task_type in WRITE_TASKS or payload.get("external_write") is True or payload.get("published") is True:
            if approved_live_ad:
                snapshot = payload.get("account_budget_snapshot")
                if not isinstance(snapshot, Mapping):
                    return self._blocked("META_ACCOUNT_BUDGET_DATA_INVALID")
                decision = account_budget_decision(snapshot)
                if not decision["allowed"]:
                    return self._blocked(decision["reason"])
                proposed = float(snapshot.get("proposed_daily_budget_eur", 0.0))
                if budget > 0 and not math.isclose(budget, proposed, abs_tol=0.001):
                    return self._blocked("PROPOSED_BUDGET_MISMATCH")
            elif approved_live_seo:
                if payload.get("external_write") is not True:
                    return self._blocked("SHOPIFY_SEO_WRITE_NOT_DECLARED")
            else:
                return self._blocked("EXTERNAL_WRITE_DISABLED")
        declared_spend = list(_declared_spend(payload))
        if ((budget > 0 and not approved_live_ad)
                or any(not math.isfinite(item) or (item > 0 and not approved_live_ad)
                       for item in declared_spend)):
            return self._blocked("UNAPPROVED_SPEND_BLOCKED")
        if payload.get("existing_campaign_mutation"):
            return self._blocked("EXISTING_CAMPAIGNS_READ_ONLY")
        if pillar == "ms_handwerk":
            if any(_BLOCKED_COPY.search(text) for text in _strings(payload)):
                return self._blocked("LEGAL_SERVICE_WORDING_BLOCKED")
            copy = payload.get("copy")
            if isinstance(copy, str):
                valid, reason = validate_legal_copy(copy)
                if not valid:
                    return self._blocked(reason or "LEGAL_SERVICE_WORDING_BLOCKED")
        return {"allowed": True, "reason": None, "budget_eur": 0.0,
                "budget_impact_eur": 0.0, "existing_campaigns": "read_only_untouched",
                "dry_run": not (approved_live_ad or approved_live_seo)}

    @staticmethod
    def _blocked(reason: str) -> dict[str, Any]:
        return {"allowed": False, "reason": reason, "budget_eur": 0.0,
                "budget_impact_eur": 0.0, "dry_run": True}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self.validate(task_type, payload, payload.get("budget_eur", payload.get("budget_impact_eur", 0.0)),
                             pillar=payload.get("pillar"))

