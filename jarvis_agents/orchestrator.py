"""In-process JSON-message orchestrator; all side effects are blocked by default."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Mapping
from .comms_agent import CommsAgent
from .erazer_priority import HANDLE
from .handwerk_agent import HandwerkAgent
from .homestro_agent import HomestroAgent
from .protocol import AgentMessage, MessageValidationError
from .risk_guard_agent import RiskGuardAgent

_MANIFEST = json.loads(Path(__file__).with_name("workforce.json").read_text(encoding="utf-8"))
PILLAR_ORDER = tuple(_MANIFEST["pillarOrder"])


class JarvisOrchestrator:
    agent_id = "orchestrator"

    def __init__(self, *, risk_guard: RiskGuardAgent | None = None):
        self.risk_guard = risk_guard or RiskGuardAgent()
        self.agents = {agent.agent_id: agent for agent in (
            HomestroAgent(), HandwerkAgent(), self.risk_guard, CommsAgent()
        )}
        self.handoffs: list[dict[str, Any]] = []
        self.completed_pillars: set[str] = set()

    def dispatch(self, message: AgentMessage | Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(message, AgentMessage):
            message = AgentMessage.from_dict(message)
        if message.recipient not in self.agents:
            raise MessageValidationError("UNKNOWN_AGENT_RECIPIENT")
        pillar = str(message.payload.get("pillar") or "homestro")
        if pillar in PILLAR_ORDER:
            current_index = PILLAR_ORDER.index(pillar)
            for earlier in PILLAR_ORDER[:current_index]:
                if earlier not in self.completed_pillars:
                    self._record(message, "blocked", "PILLAR_ORDER_BLOCKED")
                    return {"status": "blocked", "reason": "PILLAR_ORDER_BLOCKED", "pillar": pillar}
        guard = self.risk_guard.validate(message.task_type, message.payload, message.budget_impact_eur)
        if not guard["allowed"]:
            self._record(message, "blocked", str(guard["reason"]))
            return {"status": "blocked", **guard}
        agent = self.agents[message.recipient]
        result = agent.handle(message.task_type, message.payload)
        self._record(message, "completed", None)
        return {"status": "completed", "result": result, "budget_impact_eur": 0.0}

    def _record(self, message: AgentMessage, status: str, reason: str | None) -> None:
        # Retain only handoff metadata; never persist product/customer secrets or credentials.
        self.handoffs.append({"sender": message.sender, "recipient": message.recipient,
            "task_type": message.task_type, "timestamp": message.timestamp,
            "status": status, "reason": reason, "budget_impact_eur": 0.0})

    def status(self) -> dict[str, Any]:
        return {**_MANIFEST, "erazer_priority": {"rank": 1, "title": "Erazer XP6", "handle": HANDLE,
            "locked": True}, "handoffs_recorded": len(self.handoffs), "ad_spend_eur": 0.0,
            "video_generation_for_flagship": "reuse_existing_shopify_video_only"}
