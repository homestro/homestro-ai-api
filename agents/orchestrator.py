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

from agents import creative_seo, media_buyer, product_hunter, tiktok_publisher  # noqa: E402

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

    # A content-ready event carries only product IDs whose grounded draft was
    # actually produced. Downstream media preparation must consume that event,
    # rather than independently processing the full Hunter selection.
    content_product_ids = {
        str(draft.get("product_id"))
        for draft in stages["creative_seo"].get("drafts", [])
        if isinstance(draft, dict) and draft.get("product_id")
    }
    media_inputs = [
        product for product in candidates
        if str(product.get("id") or "") in content_product_ids
    ]
    if not media_inputs:
        stages["tiktok_publisher"] = {
            "status": "blocked",
            "reason": "CONTENT_READY_EVENT_EMPTY",
            "candidate_count": 0,
            "prepared_count": 0,
            "ready_count": 0,
            "review_count": 0,
            "drafts": [],
            "publication_performed": False,
            "ad_mutations_performed": False,
        }
    else:
        try:
            stages["tiktok_publisher"] = await tiktok_publisher.run_once(media_inputs, env=env)
            stages["tiktok_publisher"]["input_event"] = "content_ready"
            stages["tiktok_publisher"]["input_product_ids"] = [
                str(product.get("id")) for product in media_inputs
            ]
        except Exception as exc:
            stages["tiktok_publisher"] = {
                "status": "failed",
                "error_type": type(exc).__name__,
                "prepared_count": 0,
                "ready_count": 0,
                "review_count": 0,
                "drafts": [],
                "publication_performed": False,
                "ad_mutations_performed": False,
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
                    "prepared",
                    "collected",
                    "no_managed_campaign",
                    "no_candidates",
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
                "meta_trend_status": stages["product_hunter"].get("competitor_trends", {}).get("status"),
                "meta_active_ads_checked": stages["product_hunter"].get("competitor_trends", {}).get("active_ads_checked", 0),
                "meta_matched_products": len(stages["product_hunter"].get("competitor_trends", {}).get("matched_products", [])),
                "meta_suggestions_queued": stages["product_hunter"].get("competitor_trends", {}).get("suggestion_count", 0),
                "meta_suggestion_queue_status": stages["product_hunter"].get("competitor_trends", {}).get("queue_status"),
            },
            "creative_seo": {
                "status": stages["creative_seo"].get("status"),
                "draft_count": stages["creative_seo"].get("draft_count", 0),
                "product_ids": [
                    str(draft.get("product_id"))
                    for draft in stages["creative_seo"].get("drafts", [])
                ],
            },
            "tiktok_publisher": {
                "status": stages["tiktok_publisher"].get("status"),
                "candidate_count": stages["tiktok_publisher"].get("candidate_count", 0),
                "prepared_count": stages["tiktok_publisher"].get("prepared_count", 0),
                "ready_count": stages["tiktok_publisher"].get("ready_count", 0),
                "review_count": stages["tiktok_publisher"].get("review_count", 0),
                "reason": stages["tiktok_publisher"].get("reason"),
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
        "tiktok_upload_performed": False,
        "tiktok_ad_spend_eur": 0,
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
