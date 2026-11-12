"""Versioned, JSON-safe protocol for internal JARVIS agent handoffs."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import math
from typing import Any, Mapping


class MessageValidationError(ValueError):
    """Raised when a handoff is malformed or unsafe to route."""


@dataclass(frozen=True, slots=True)
class AgentMessage:
    sender: str
    recipient: str
    task_type: str
    payload: dict[str, Any]
    budget_impact_eur: float = 0.0
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def __post_init__(self) -> None:
        if not self.sender.strip() or not self.recipient.strip() or not self.task_type.strip():
            raise MessageValidationError("sender, recipient and task_type are required")
        if not isinstance(self.payload, dict):
            raise MessageValidationError("payload must be a JSON object")
        if isinstance(self.budget_impact_eur, bool) or not math.isfinite(float(self.budget_impact_eur)):
            raise MessageValidationError("budget_impact_eur must be finite")
        if float(self.budget_impact_eur) < 0:
            raise MessageValidationError("budget_impact_eur cannot be negative")
        try:
            parsed = datetime.fromisoformat(self.timestamp.replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise MessageValidationError("timestamp must be ISO-8601") from exc
        if parsed.tzinfo is None:
            raise MessageValidationError("timestamp must include a timezone")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "AgentMessage":
        required = {"sender", "recipient", "task_type", "payload", "budget_impact_eur", "timestamp"}
        if not isinstance(value, Mapping) or not required.issubset(value):
            raise MessageValidationError("AgentMessage fields are incomplete")
        return cls(**{key: value[key] for key in required})
