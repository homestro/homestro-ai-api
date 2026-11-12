"""Pillar-ordered in-process workforce; every handoff is risk-audited and dry-run."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Mapping
from uuid import uuid4

from .ai_influencer_agent import AIInfluencerAgent
from .comms_agent import CommsAgent
from .erazer_priority import HANDLE
from .handwerk_agent import HandwerkAgent
from .homestro_agent import HomestroAgent
from .kids_youtube_agent import KidsYouTubeAgent
from .protocol import AgentMessage, InMemoryMessageBus, MessageValidationError
from .risk_guard_agent import RiskGuardAgent

_MANIFEST = json.loads(Path(__file__).with_name("workforce.json").read_text(encoding="utf-8"))
PILLAR_ORDER = tuple(_MANIFEST["pillarOrder"])


class JarvisOrchestrator:
    agent_id = "orchestrator"
    mission = "Coordinate four business pillars in order and risk-audit every handoff."

    def __init__(self, *, risk_guard: RiskGuardAgent | None = None,
                 bus: InMemoryMessageBus | None = None):
        self.risk_guard = risk_guard or RiskGuardAgent()
        self.bus = bus or InMemoryMessageBus()
        # Compatibility for callers that inspected the earlier list attribute.
        self.handoffs = self.bus.messages
        self.agents = {agent.agent_id: agent for agent in (
            HomestroAgent(), HandwerkAgent(), KidsYouTubeAgent(), AIInfluencerAgent(), self.risk_guard
        )}
        self.completed_pillars: set[str] = set()
        self.last_cycle: dict[str, Any] | None = None

    def dispatch(self, message: AgentMessage | Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(message, AgentMessage):
            message = AgentMessage.from_dict(message)
        if message.recipient not in self.agents:
            raise MessageValidationError("UNKNOWN_AGENT_RECIPIENT")
        if message.pillar not in PILLAR_ORDER and message.pillar != "all":
            raise MessageValidationError("UNKNOWN_PILLAR")
        request_record = self.bus.publish(message)
        audit = self.risk_guard.audit_message(message)
        self._audit_record(message, audit)
        if not audit["allowed"]:
            self.bus.set_status(request_record, "blocked")
            return {"status": "blocked", **audit}
        if message.pillar in PILLAR_ORDER:
            current_index = PILLAR_ORDER.index(message.pillar)
            if any(earlier not in self.completed_pillars for earlier in PILLAR_ORDER[:current_index]):
                self.bus.set_status(request_record, "blocked")
                return {"status": "blocked", "reason": "PILLAR_ORDER_BLOCKED", "pillar": message.pillar}

        self.bus.set_status(request_record, "running")
        try:
            result = self.agents[message.recipient].handle(message.task_type, message.payload)
            response = AgentMessage(sender=message.recipient, recipient=self.agent_id,
                pillar=message.pillar, task_type="task_result", payload=result, budget_eur=0.0,
                status="queued")
            response_audit = self.risk_guard.audit_message(response)
            self._audit_record(response, response_audit)
            if not response_audit["allowed"]:
                self.bus.set_status(request_record, "blocked")
                self.bus.publish(response.with_status("blocked"))
                return {"status": "blocked", **response_audit}
            self.bus.publish(response.with_status("completed"))
            self.bus.set_status(request_record, "completed")
            if message.pillar in PILLAR_ORDER:
                self.completed_pillars.add(message.pillar)
            return {"status": "completed", "result": result, "budget_eur": 0.0}
        except Exception as exc:
            self.bus.set_status(request_record, "failed")
            return {"status": "failed", "reason": str(exc)[:120], "budget_eur": 0.0}

    def _audit_record(self, message: AgentMessage, audit: Mapping[str, Any]) -> None:
        audit_message = AgentMessage(sender=self.risk_guard.agent_id, recipient=self.agent_id,
            pillar=message.pillar, task_type="risk_audit", payload={
                "audited_sender": message.sender, "audited_recipient": message.recipient,
                "audited_task": message.task_type, "allowed": bool(audit.get("allowed")),
                "reason": audit.get("reason"),
            }, budget_eur=0.0, status="completed" if audit.get("allowed") else "blocked")
        self.bus.publish(audit_message)

    def cycle(self) -> dict[str, Any]:
        """Run a deterministic, no-network/no-write planning cycle over all pillars."""
        cycle_id = str(uuid4())
        started_at = datetime.now(timezone.utc).isoformat()
        first_message = len(self.bus.messages)
        tasks = (
            ("homestro", "homestro", "prepare_pillar_brief", {}),
            ("ms_handwerk", "handwerk", "draft_local_services", {"pillar": "ms_handwerk"}),
            ("kids_youtube", "kids_youtube", "draft_kids_short", {"episode": 1}),
            ("ai_influencers", "ai_influencers", "draft_virtual_persona", {}),
        )
        results = []
        for pillar, recipient, task_type, payload in tasks:
            message = AgentMessage(sender=self.agent_id, recipient=recipient, pillar=pillar,
                                   task_type=task_type, payload=payload, budget_eur=0.0)
            response = self.dispatch(message)
            results.append({"pillar": pillar, "agent": recipient, **response})
            if response.get("status") != "completed":
                break

        cycle_status = "completed" if len(results) == len(tasks) and all(
            result["status"] == "completed" for result in results) else "blocked"
        draft_status = {"erazer_priority": {"rank": 1, "title": "Erazer XP6", "handle": HANDLE,
                                              "locked": True},
                        "pillar_results": results, "dry_run": True, "ad_spend_eur": 0.0}
        report_input = {"pillar_results": results, "erazer_priority": draft_status["erazer_priority"]}
        comms_audit = self.risk_guard.validate("format_status", report_input, 0.0, pillar="all")
        self._audit_record(AgentMessage(sender="orchestrator", recipient="comms", pillar="all",
            task_type="format_status", payload=report_input, budget_eur=0.0), comms_audit)
        report = CommsAgent().format_cycle({**draft_status, "status": cycle_status})
        self.bus.publish(AgentMessage(sender="comms", recipient="orchestrator", pillar="all",
            task_type="cycle_summary", payload=report, budget_eur=0.0, status="completed"))
        cycle = {"cycle_id": cycle_id, "status": cycle_status, "started_at": started_at,
                 "finished_at": datetime.now(timezone.utc).isoformat(), "dry_run": True,
                 "budget_eur": 0.0, "ad_spend_eur": 0.0, "video_generation_performed": False,
                 "external_writes_performed": False, "pillar_results": results,
                 "summary_report": report, "communication_log": self.bus.messages[first_message:]}
        self.last_cycle = cycle
        return cycle

    def status(self) -> dict[str, Any]:
        return {**_MANIFEST, "erazer_priority": {"rank": 1, "title": "Erazer XP6", "handle": HANDLE,
            "locked": True}, "handoffs_recorded": len(self.bus.messages), "ad_spend_eur": 0.0,
            "video_generation_for_flagship": "reuse_existing_shopify_video_only",
            "last_cycle": self.last_cycle,
            "last_communication": self.bus.messages[-1] if self.bus.messages else None}
