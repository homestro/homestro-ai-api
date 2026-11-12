"""Validated, JSON-safe agent messages and an in-memory handoff bus."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import math
from typing import Any, Mapping


class MessageValidationError(ValueError):
    """Raised when a handoff is malformed or unsafe to route."""


MESSAGE_STATUSES = {"queued", "running", "completed", "blocked", "failed"}


@dataclass(frozen=True, slots=True)
class AgentMessage:
    sender: str
    recipient: str
    task_type: str
    payload: dict[str, Any]
    pillar: str = "homestro"
    budget_eur: float = 0.0
    status: str = "queued"
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def __post_init__(self) -> None:
        if not all(isinstance(value, str) and value.strip() for value in
                   (self.sender, self.recipient, self.pillar, self.task_type)):
            raise MessageValidationError("sender, recipient, pillar and task_type are required")
        if not isinstance(self.payload, dict):
            raise MessageValidationError("payload must be a JSON object")
        try:
            budget = float(self.budget_eur)
        except (TypeError, ValueError) as exc:
            raise MessageValidationError("budget_eur must be numeric") from exc
        if isinstance(self.budget_eur, bool) or not math.isfinite(budget) or budget < 0:
            raise MessageValidationError("budget_eur must be finite and nonnegative")
        object.__setattr__(self, "budget_eur", budget)
        if self.status not in MESSAGE_STATUSES:
            raise MessageValidationError("status is invalid")
        try:
            parsed = datetime.fromisoformat(self.timestamp.replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise MessageValidationError("timestamp must be ISO-8601") from exc
        if parsed.tzinfo is None:
            raise MessageValidationError("timestamp must include a timezone")

    @property
    def budget_impact_eur(self) -> float:
        """Compatibility alias for the earlier internal protocol revision."""
        return float(self.budget_eur)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def with_status(self, status: str) -> "AgentMessage":
        return replace(self, status=status)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "AgentMessage":
        required = {"sender", "recipient", "task_type", "payload"}
        if not isinstance(value, Mapping) or not required.issubset(value):
            raise MessageValidationError("AgentMessage fields are incomplete")
        budget = value.get("budget_eur", value.get("budget_impact_eur", 0.0))
        return cls(sender=value["sender"], recipient=value["recipient"],
                   pillar=value.get("pillar", "homestro"), task_type=value["task_type"],
                   payload=value["payload"], budget_eur=budget,
                   status=value.get("status", "queued"),
                   timestamp=value.get("timestamp", datetime.now(timezone.utc).isoformat()))


class InMemoryMessageBus:
    """Process-local audit trail; message payloads are retained for cycle review."""

    def __init__(self, max_messages: int = 500):
        self.max_messages = max(10, int(max_messages))
        self.messages: list[dict[str, Any]] = []

    def publish(self, message: AgentMessage) -> dict[str, Any]:
        record = message.to_dict()
        self.messages.append(record)
        if len(self.messages) > self.max_messages:
            del self.messages[:-self.max_messages]
        return record

    def set_status(self, record: dict[str, Any], status: str) -> dict[str, Any]:
        if status not in MESSAGE_STATUSES:
            raise MessageValidationError("status is invalid")
        record["status"] = status
        record["updated_at"] = datetime.now(timezone.utc).isoformat()
        return record

    def last_for(self, agent_id: str) -> dict[str, Any] | None:
        for message in reversed(self.messages):
            if message.get("sender") == agent_id or message.get("recipient") == agent_id:
                return {key: value for key, value in message.items() if key != "payload"}
        return None
