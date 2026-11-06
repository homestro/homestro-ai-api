"""Read and log current Meta campaign delivery metrics for the managed pilot."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PILOT_SOURCE = REPOSITORY_ROOT / "homestro-marketing-pilot"
if str(PILOT_SOURCE) not in sys.path:
    sys.path.insert(0, str(PILOT_SOURCE))

from adtech_pilot.media_buyer import PlanAuditStore  # noqa: E402
from adtech_pilot.performance_loader import load_meta_performance  # noqa: E402

logger = logging.getLogger("homestro.agents.media_buyer")


class _MetricsAudit:
    """Use the existing pilot audit DB, with an optional exact campaign override."""

    def __init__(self, audit: PlanAuditStore, env: dict[str, str]) -> None:
        self.audit = audit
        self.env = env

    async def get_meta_micro_campaign_claim(self) -> dict[str, str | None] | None:
        campaign_id = self.env.get("PILOT_METRICS_CAMPAIGN_ID", "").strip()
        if campaign_id:
            return {"campaign_id": campaign_id}
        return await self.audit.get_meta_micro_campaign_claim()

    async def record(self, kind: str, payload: dict[str, Any]) -> str:
        return await self.audit.record(kind, payload)


def _log_snapshot(result: dict[str, Any]) -> None:
    rows = result.get("metrics", [])
    snapshot = {
        "agent": "media_buyer",
        "logged_at": datetime.now(UTC).isoformat(),
        "status": result.get("status"),
        "window": result.get("window", "maximum"),
        "reason": result.get("reason"),
        "campaign_id": (rows[0].get("campaign_id") if rows else None),
        "metrics": [
            {
                "campaign_id": row.get("campaign_id"),
                "spend_eur": row.get("spend_eur"),
                "clicks": row.get("clicks"),
                "reported_conversions": row.get("reported_purchases"),
                "impressions": row.get("impressions"),
                "date_start": row.get("date_start"),
                "date_stop": row.get("date_stop"),
            }
            for row in rows
        ],
    }
    logger.info("campaign_metrics %s", json.dumps(snapshot, separators=(",", ":")))


async def run_once(env: dict[str, str] | None = None) -> dict[str, Any]:
    """Fetch Meta lifetime metrics and log them; this agent performs no ad writes."""
    env = os.environ if env is None else env
    database_path = Path(
        env.get("PILOT_AUDIT_DB_PATH", "/tmp/homestro-adtech/audit.sqlite3")
    )
    audit = PlanAuditStore(database_path)
    result = await load_meta_performance(
        _MetricsAudit(audit, env), env=env, window="maximum"
    )
    _log_snapshot(result)
    return result


def main() -> int:
    logging.basicConfig(
        level=os.getenv("MEDIA_BUYER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        result = asyncio.run(run_once())
    except Exception as exc:
        # Do not print provider response bodies or environment values; they may contain secrets.
        logger.error("campaign_metrics status=failed error_type=%s", type(exc).__name__)
        return 1
    return 0 if result.get("status") in {"collected", "no_managed_campaign"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
