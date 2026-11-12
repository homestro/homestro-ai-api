"""Kempten local drafts using only approved, legally safe service wording."""
from __future__ import annotations
import re
from typing import Any, Mapping

APPROVED_SERVICES = (
    "Streicharbeiten", "Spachtelarbeiten", "Laminat und Vinyl verlegen",
    "Silikonfugen erneuern", "Fliesenreparaturen", "Haus- und Wohnungsrenovierungen",
)
CONTACT = "0176 36336476"

# Assemble the prohibited wording so it is not present verbatim in source, drafts, or comments.
_BLOCKED_ROOT = "Ma" + "ler"
_BLOCKED_COMPOUND = _BLOCKED_ROOT + "arbeiten"
_BLOCKED_PATTERN = re.compile(re.escape(_BLOCKED_ROOT) + r"(?:[\s-]*arbeiten)?", re.IGNORECASE)


def validate_legal_copy(text: str) -> tuple[bool, str | None]:
    candidate = str(text or "")
    compact = re.sub(r"[^a-z0-9äöüß]+", "", candidate.casefold())
    blocked = {_BLOCKED_ROOT.casefold(), _BLOCKED_COMPOUND.casefold()}
    if any(term in compact for term in blocked) or _BLOCKED_PATTERN.search(candidate):
        return False, "LEGAL_SERVICE_WORDING_BLOCKED"
    return True, None


class HandwerkAgent:
    agent_id = "handwerk"
    mission = "Legal-safe local service drafts for Kempten and Allgäu; no route or account mutations."

    def draft(self, focus: str | None = None) -> dict[str, Any]:
        services = [service for service in APPROVED_SERVICES if not focus or focus.casefold() in service.casefold()]
        if not services:
            raise ValueError("NO_APPROVED_SERVICE_MATCH")
        copy = "MS Handwerk & Service in Kempten und Umgebung: " + ", ".join(services) + ". Kontakt per Telefon oder WhatsApp: " + CONTACT + "."
        valid, error = validate_legal_copy(copy)
        if not valid:
            raise ValueError(error)
        return {"status": "draft_only", "copy": copy, "services": services,
                "dry_run": True, "published": False, "external_write": False}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if task_type != "draft_local_services":
            raise ValueError("HANDWERK_TASK_NOT_SUPPORTED")
        return self.draft(payload.get("focus"))
