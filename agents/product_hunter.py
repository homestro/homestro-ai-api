"""Read the configured Homestro feed and rank purchase candidates using verified costs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PILOT_SOURCE = REPOSITORY_ROOT / "homestro-marketing-pilot"
if str(PILOT_SOURCE) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(PILOT_SOURCE))

from adtech_pilot.feed_manager import ProductFeedManager  # noqa: E402
from adtech_pilot.product_selection import select_cost_candidates  # noqa: E402

logger = logging.getLogger("homestro.agents.product_hunter")


async def _read_feed(env: dict[str, str]) -> bytes:
    feed_path = env.get("PILOT_PRODUCT_FEED_PATH", "").strip()
    if feed_path:
        return Path(feed_path).read_bytes()

    feed_url = (
        env.get("PILOT_PRODUCT_FEED_URL", "").strip()
        or env.get("PILOT_FEED_URL", "").strip()
        or env.get("HOMESTRO_PRODUCT_FEED_URL", "").strip()
    )
    parsed = urlsplit(feed_url)
    if (parsed.scheme != "https" or parsed.hostname not in {
        "homestro.de", "www.homestro.de",
        "homestro-ai-api-fixed-current-production.up.railway.app",
    } or parsed.username or parsed.password):
        raise ValueError("PRODUCT_FEED_SOURCE_NOT_CONFIGURED")
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20, connect=5), follow_redirects=False
    ) as client:
        response = await client.get(feed_url)
        response.raise_for_status()
        return response.content


def _read_verified_costs(env: dict[str, str]) -> dict[str, dict[str, str]]:
    database_path = Path(
        env.get("PILOT_PAYMENT_DB_PATH", "/data/adtech-pilot/payments.sqlite3")
    )
    if not database_path.is_file():
        raise FileNotFoundError("UNIT_COST_DATABASE_UNAVAILABLE")
    uri = database_path.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        rows = db.execute(
            "SELECT variant, amount, currency, observed_at FROM pilot_unit_costs"
        ).fetchall()
    return {
        str(variant): {
            "amount": str(amount),
            "currency": str(currency),
            "observed_at": str(observed_at),
        }
        for variant, amount, currency, observed_at in rows
    }


async def run_once(env: dict[str, str] | None = None) -> dict[str, Any]:
    """Return eligible products only when feed availability and recent EUR costs verify."""
    env = dict(os.environ if env is None else env)
    try:
        payload = await _read_feed(env)
    except (OSError, ValueError, httpx.HTTPError) as exc:
        result = {
            "status": "blocked",
            "reason": str(exc) if isinstance(exc, ValueError) else "PRODUCT_FEED_READ_FAILED",
            "products_checked": 0,
            "candidates": [],
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    report = ProductFeedManager().parse(payload)
    products = [product.model_dump(mode="json") for product in report.products]
    if not products:
        result = {
            "status": "blocked",
            "reason": "NO_VALID_FEED_PRODUCTS",
            "rejected_rows": report.rejected_rows,
            "candidates": [],
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    try:
        costs = _read_verified_costs(env)
    except (OSError, sqlite3.Error):
        result = {
            "status": "blocked",
            "reason": "UNIT_COST_DATABASE_UNAVAILABLE",
            "products_checked": len(products),
            "rejected_rows": report.rejected_rows,
            "candidates": [],
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    candidates, selection = select_cost_candidates(
        products, costs, now=datetime.now(UTC)
    )
    limit = max(1, min(int(env.get("PILOT_HUNTER_LIMIT", "10")), 10))
    result = {
        "status": "selected" if candidates else "no_eligible_products",
        "source_format": report.source_format,
        "products_checked": len(products),
        "invalid_feed_rows": report.rejected_rows,
        "selection": selection,
        "candidates": candidates[:limit],
        "candidate_count_returned": min(len(candidates), limit),
    }
    logger.info(
        "product_hunter %s",
        json.dumps(
            {
                "status": result["status"],
                "source_format": result["source_format"],
                "products_checked": result["products_checked"],
                "invalid_feed_rows": result["invalid_feed_rows"],
                "candidate_count_returned": result["candidate_count_returned"],
                "product_ids": [str(product["id"]) for product in result["candidates"]],
                "rejected_by_reason": selection["rejected_by_reason"],
            },
            separators=(",", ":"),
        ),
    )
    return result


def main() -> int:
    logging.basicConfig(
        level=os.getenv("PRODUCT_HUNTER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    result = asyncio.run(run_once())
    return 0 if result.get("status") in {"selected", "no_eligible_products"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
