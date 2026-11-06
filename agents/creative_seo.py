"""Prepare grounded ad-copy and SEO/GEO drafts from eligible feed products."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PILOT_SOURCE = REPOSITORY_ROOT / "homestro-marketing-pilot"
if str(PILOT_SOURCE) not in sys.path:
    sys.path.insert(0, str(PILOT_SOURCE))

from adtech_pilot.content_engine import content_batch  # noqa: E402

logger = logging.getLogger("homestro.agents.creative_seo")


def prepare(products: list[dict[str, Any]], *, limit: int = 10) -> dict[str, Any]:
    """Build local, reviewable drafts; make no provider, Shopify, or publishing calls."""
    batch = content_batch(products, limit=max(1, min(limit, 10)))
    drafts = [
        {
            "product_id": draft["product_id"],
            "product_url": draft["source_url"],
            "ad": draft["ad"],
            "seo": draft["seo"],
            "geo": draft["geo"],
            "brief_version": draft["brief_version"],
            "brief_hash": draft["brief_hash"],
            "claims_policy": "validated_feed_facts_only",
            "paid_generation_performed": False,
            "storefront_mutations_performed": False,
            "publication_performed": False,
            "requires_refresh_before_publication": True,
        }
        for draft in batch["drafts"]
    ]
    return {
        "status": "drafted" if drafts else "no_drafts",
        "draft_count": len(drafts),
        "drafts": drafts,
        "ai_search_inclusion_verified": False,
        "publication_performed": False,
    }


async def run_once(
    products: list[dict[str, Any]], *, env: dict[str, str] | None = None
) -> dict[str, Any]:
    env = os.environ if env is None else env
    limit = max(1, min(int(env.get("PILOT_CREATIVE_SEO_LIMIT", "10")), 10))
    result = prepare(products, limit=limit)
    logger.info(
        "creative_seo %s",
        json.dumps(
            {
                "status": result["status"],
                "draft_count": result["draft_count"],
                "product_ids": [draft["product_id"] for draft in result["drafts"]],
                "paid_generation_performed": False,
                "publication_performed": False,
            },
            separators=(",", ":"),
        ),
    )
    return result


def main() -> int:
    logging.basicConfig(
        level=os.getenv("CREATIVE_SEO_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger.error("creative_seo requires products from the orchestrator")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
