"""Run the read-only Homestro marketing agent chain in a fixed order."""

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
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from agents import creative_seo, media_buyer, product_hunter  # noqa: E402

logger = logging.getLogger("homestro.agents.orchestrator")


async def run_once(env: dict[str, str] | None = None) -> dict[str, Any]:
    env = dict(os.environ if env is None else env)
    started_at = datetime.now(UTC).isoformat()
    stages: dict[str, Any] = {}

    try:
        stages["product_hunter"] = await product_hunter.run_once(env)
    except Exception as exc:
        stages["product_hunter"] = {
            "status": "failed",
            "error_type": type(exc).__name__,
            "candidates": [],
        }

    candidates = stages["product_hunter"].get("candidates", [])
    try:
        stages["creative_seo"] = await creative_seo.run_once(candidates, env=env)
    except Exception as exc:
        stages["creative_seo"] = {
            "status": "failed",
            "error_type": type(exc).__name__,
            "draft_count": 0,
            "drafts": [],
        }

    try:
        stages["media_buyer"] = await media_buyer.run_once(env=env)
    except Exception as exc:
        stages["media_buyer"] = {
            "status": "failed",
            "error_type": type(exc).__name__,
            "metrics": [],
        }

    statuses = [stage.get("status") for stage in stages.values()]
    result = {
        "agent": "orchestrator",
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(),
        "status": (
            "completed"
            if all(
                status in {
                    "selected",
                    "no_eligible_products",
                    "drafted",
                    "no_drafts",
                    "collected",
                    "no_managed_campaign",
                }
                for status in statuses
            )
            else "completed_with_blockers"
        ),
        "stages": {
            "product_hunter": {
                "status": stages["product_hunter"].get("status"),
                "candidate_count": len(candidates),
                "product_ids": [str(product.get("id")) for product in candidates],
                "reason": stages["product_hunter"].get("reason"),
            },
            "creative_seo": {
                "status": stages["creative_seo"].get("status"),
                "draft_count": stages["creative_seo"].get("draft_count", 0),
                "product_ids": [
                    str(draft.get("product_id"))
                    for draft in stages["creative_seo"].get("drafts", [])
                ],
            },
            "media_buyer": {
                "status": stages["media_buyer"].get("status"),
                "metrics": stages["media_buyer"].get("metrics", []),
                "reason": stages["media_buyer"].get("reason"),
            },
        },
        "paid_generation_performed": False,
        "publication_performed": False,
        "ad_mutations_performed": False,
    }
    logger.info("agent_chain %s", json.dumps(result, separators=(",", ":")))
    return {"status": result["status"], "stages": stages, "log_record": result}


def main() -> int:
    logging.basicConfig(
        level=os.getenv("AGENT_ORCHESTRATOR_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    result = asyncio.run(run_once())
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
