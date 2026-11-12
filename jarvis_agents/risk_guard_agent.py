"""Fail-closed controller for spending, publishing, existing campaigns and legal copy."""
from __future__ import annotations
from typing import Any, Mapping
from .erazer_priority import is_erazer_xp6
from .handwerk_agent import validate_legal_copy

WRITE_TASKS = {"publish", "campaign_write", "campaign_activate", "video_generate", "send_whatsapp"}


class RiskGuardAgent:
    agent_id = "risk_guard"
    mission = "Block unapproved spend and external mutations; preserve existing campaigns."

    def validate(self, task_type: str, payload: Mapping[str, Any], budget_impact_eur: float = 0.0) -> dict[str, Any]:
        product = payload.get("product")
        if task_type == "video_generate" and isinstance(product, Mapping) and is_erazer_xp6(product):
            return {"allowed": False, "reason": "FLAGSHIP_RUNWAY_GENERATION_FORBIDDEN", "budget_impact_eur": 0.0}
        if task_type in WRITE_TASKS:
            return {"allowed": False, "reason": "EXTERNAL_WRITE_DISABLED", "budget_impact_eur": 0.0}
        if float(budget_impact_eur) != 0.0:
            return {"allowed": False, "reason": "UNAPPROVED_SPEND_BLOCKED", "budget_impact_eur": 0.0}
        if payload.get("existing_campaign_mutation"):
            return {"allowed": False, "reason": "EXISTING_CAMPAIGNS_READ_ONLY", "budget_impact_eur": 0.0}
        text = payload.get("copy")
        if isinstance(text, str) and payload.get("pillar") == "ms_handwerk":
            valid, reason = validate_legal_copy(text)
            if not valid:
                return {"allowed": False, "reason": reason, "budget_impact_eur": 0.0}
        return {"allowed": True, "reason": None, "budget_impact_eur": 0.0,
                "existing_campaigns": "read_only_untouched", "dry_run": True}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self.validate(task_type, payload, float(payload.get("budget_impact_eur", 0.0)))
