"""Fail-closed audit of every agent handoff, spend request and external action."""
from __future__ import annotations

import math
import re
from typing import Any, Mapping

from .erazer_priority import is_erazer_xp6
from .handwerk_agent import validate_legal_copy
from .protocol import AgentMessage

WRITE_TASKS = {"publish", "campaign_write", "campaign_activate", "video_generate", "send_whatsapp",
               "shopify_write", "render_video", "paid_generation"}
_BLOCKED_ROOT = "Ma" + "ler"
_BLOCKED_COPY = re.compile(re.escape(_BLOCKED_ROOT) + r"(?:[\s-]*arbeiten)?", re.IGNORECASE)


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
        if task_type in WRITE_TASKS or payload.get("external_write") is True or payload.get("published") is True:
            return self._blocked("EXTERNAL_WRITE_DISABLED")
        if budget > 0 or any(not math.isfinite(item) or item > 0 for item in _declared_spend(payload)):
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
                "budget_impact_eur": 0.0, "existing_campaigns": "read_only_untouched", "dry_run": True}

    @staticmethod
    def _blocked(reason: str) -> dict[str, Any]:
        return {"allowed": False, "reason": reason, "budget_eur": 0.0,
                "budget_impact_eur": 0.0, "dry_run": True}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self.validate(task_type, payload, payload.get("budget_eur", payload.get("budget_impact_eur", 0.0)),
                             pillar=payload.get("pillar"))
