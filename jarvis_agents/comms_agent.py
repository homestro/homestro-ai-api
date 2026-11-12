"""Owner-facing status formatter. It does not connect to or send WhatsApp messages."""
from __future__ import annotations
from typing import Any, Mapping


class CommsAgent:
    agent_id = "comms"
    mission = "Format concise owner-ready reports; external delivery disabled."

    def format_status(self, status: Mapping[str, Any]) -> dict[str, Any]:
        xp6 = status.get("erazer_priority", {})
        text = (f"JARVIS: Homestro je priorita 1; Erazer XP6 ({xp6.get('handle', 'configured handle')}) "
                f"je uzamčen na pozici #{xp6.get('rank', 1)}. Režim: dry-run, útrata 0 €. "
                "Stávající kampaně zůstávají beze změny.")
        return {"text": text, "channel": "whatsapp_ready", "sent": False, "spend_eur": 0.0}

    def format_cycle(self, cycle: Mapping[str, Any]) -> dict[str, Any]:
        pillars = cycle.get("pillar_results", [])
        completed = sum(item.get("status") == "completed" for item in pillars if isinstance(item, Mapping))
        total = len(pillars)
        return {"text": (f"JARVIS cyklus {cycle.get('status', 'unknown')}: {completed}/{total} pilíře, "
                          "režim dry-run, náklady 0 €. Žádná kampaň, publikace ani video nebyly spuštěny."),
                "channel": "whatsapp_ready", "sent": False, "spend_eur": 0.0,
                "completed_pillars": completed, "total_pillars": total}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if task_type != "format_status":
            raise ValueError("COMMS_TASK_NOT_SUPPORTED")
        return self.format_status(payload)
