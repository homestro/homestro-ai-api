"""Read the configured Homestro feed and rank purchase candidates using verified costs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
from collections import Counter
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
from adtech_pilot.media_buyer import MetaAdLibraryClient, PlanAuditStore  # noqa: E402
from adtech_pilot.product_selection import select_cost_candidates  # noqa: E402

logger = logging.getLogger("homestro.agents.product_hunter")
_TREND_AUDIT_KIND = "product_trend_queue"
_TREND_MEMORY_CACHE: tuple[datetime, dict[str, Any]] | None = None
_TREND_STOPWORDS = {
    "aber", "alle", "auch", "dass", "dein", "deine", "dieser", "dieses",
    "eine", "einer", "eines", "fuer", "from", "home", "ihre", "jetzt",
    "oder", "sein", "sind", "that", "this", "und", "with", "your",
}


def _bounded_int(env: dict[str, str], name: str, default: int, maximum: int) -> int:
    try:
        return max(1, min(int(env.get(name, str(default))), maximum))
    except (TypeError, ValueError):
        return default


def _search_terms(products: list[dict[str, Any]], env: dict[str, str]) -> list[str]:
    configured = env.get("META_AD_LIBRARY_SEARCH_TERMS", "")
    terms = [part.strip()[:80] for part in re.split(r"[,\n;]", configured) if part.strip()]
    if not terms:
        counts: Counter[str] = Counter()
        for product in products:
            category = str(
                product.get("product_type") or product.get("google_product_category") or ""
            ).strip()
            if category:
                counts[category] += 1
        terms = [category for category, _ in counts.most_common(5)]
    if not terms:
        terms = ["Wohnen", "Küche", "Haushalt", "Garten"]
    limit = _bounded_int(env, "META_AD_LIBRARY_MAX_TERMS", 3, 5)
    unique: list[str] = []
    seen: set[str] = set()
    for term in terms:
        key = term.casefold()
        if key not in seen:
            unique.append(term)
            seen.add(key)
        if len(unique) >= limit:
            break
    return unique


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-zäöüß]{4,}", value.casefold())
        if token not in _TREND_STOPWORDS
    }


def _ad_age_days(started_at: str | None, *, now: datetime) -> int | None:
    if not started_at:
        return None
    try:
        started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
        return max(0, (now - started.astimezone(UTC)).days)
    except (TypeError, ValueError, OverflowError):
        return None


async def _scan_meta_trends(
    products: list[dict[str, Any]], env: dict[str, str]
) -> dict[str, Any]:
    """Read bounded active German ads, cache scans and persist review-only proposals."""
    global _TREND_MEMORY_CACHE
    token = (env.get("META_AD_LIBRARY_ACCESS_TOKEN") or env.get("META_ACCESS_TOKEN") or "").strip()
    if not token:
        return {"status": "skipped", "reason": "META_AD_LIBRARY_ACCESS_TOKEN_MISSING"}

    interval_hours = _bounded_int(env, "META_AD_LIBRARY_SCAN_INTERVAL_HOURS", 6, 72)
    store: PlanAuditStore | None = None
    try:
        store = PlanAuditStore(Path(env.get("PILOT_AUDIT_DB_PATH", "/data/adtech-pilot/audit.sqlite3")))
    except (OSError, sqlite3.Error):
        logger.warning("product_hunter_trend_audit_unavailable")

    if store is not None:
        try:
            previous = await store.latest_record(_TREND_AUDIT_KIND)
            if previous:
                created = datetime.fromisoformat(str(previous["created_at"]).replace("Z", "+00:00"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=UTC)
                age_seconds = (datetime.now(UTC) - created.astimezone(UTC)).total_seconds()
                cached_payload = previous.get("payload")
                if age_seconds < interval_hours * 3600 and isinstance(cached_payload, dict):
                    _TREND_MEMORY_CACHE = (created.astimezone(UTC), cached_payload)
                    return {
                        **cached_payload,
                        "queue_status": "persisted_for_review",
                        "cache_hit": True,
                    }
        except (OSError, sqlite3.Error, KeyError, TypeError, ValueError):
            logger.warning("product_hunter_trend_cache_read_failed")
    if _TREND_MEMORY_CACHE is not None:
        cached_at, cached_payload = _TREND_MEMORY_CACHE
        if (datetime.now(UTC) - cached_at).total_seconds() < interval_hours * 3600:
            return {
                **cached_payload,
                "queue_status": "audit_unavailable",
                "cache_hit": True,
            }

    terms = _search_terms(products, env)
    limit = _bounded_int(env, "META_AD_LIBRARY_ADS_PER_TERM", 15, 25)
    minimum_age = _bounded_int(env, "META_AD_LIBRARY_MIN_TREND_AGE_DAYS", 7, 30)
    errors: list[str] = []
    ads_by_id: dict[str, dict[str, Any]] = {}
    client = MetaAdLibraryClient(
        token, api_version=env.get("META_GRAPH_VERSION", "v26.0").strip() or "v26.0"
    )
    for term in terms:
        try:
            ads = await client.search([term], country="DE", limit=limit, active_only=True)
        except httpx.HTTPStatusError as exc:
            errors.append(f"META_AD_LIBRARY_HTTP_{exc.response.status_code}")
            if exc.response.status_code in {400, 401, 403, 404, 429}:
                break
            continue
        except httpx.HTTPError as exc:
            errors.append(f"META_AD_LIBRARY_{type(exc).__name__.upper()}")
            break
        except (ValueError, TypeError):
            errors.append("META_AD_LIBRARY_INVALID_RESPONSE")
            break
        except Exception:
            errors.append("META_AD_LIBRARY_SCAN_FAILED")
            break
        for ad in ads:
            library_id = str(ad.library_id).strip()
            if library_id:
                row = ads_by_id.setdefault(library_id, {"ad": ad, "terms": set()})
                row["terms"].add(term)

    now = datetime.now(UTC)
    product_tokens = {
        str(product.get("id", "")): _tokens(" ".join(
            str(product.get(key) or "")
            for key in ("title", "product_type", "google_product_category", "tags")
        ))
        for product in products
        if str(product.get("id", "")).strip()
    }
    product_by_id = {str(product.get("id", "")): product for product in products}
    ranked_ads: list[dict[str, Any]] = []
    matched_scores: dict[str, dict[str, Any]] = {}
    suggestions: list[dict[str, Any]] = []
    for library_id, observed in ads_by_id.items():
        ad = observed["ad"]
        age_days = _ad_age_days(ad.started_at, now=now)
        if age_days is None or age_days < minimum_age:
            continue
        score = min(100, round(age_days * 100 / 14))
        copy = [str(text)[:500] for text in ad.ad_copy[:2]]
        ad_tokens = _tokens(" ".join(copy))
        matches = []
        for product_id, tokens in product_tokens.items():
            overlap = sorted(tokens.intersection(ad_tokens))
            if len(overlap) >= 2:
                matches.append((product_id, overlap))
        matched_ids = [product_id for product_id, _ in matches]
        ranked_ads.append({
            "library_id": library_id,
            "page_name": str(ad.page_name)[:160],
            "started_at": ad.started_at,
            "observed_age_days": age_days,
            "longevity_score": score,
            "signal": "durable_ad_signal" if age_days >= 14 else "emerging_ad_signal",
            "matched_search_terms": sorted(observed["terms"]),
            "matched_product_ids": matched_ids,
            "copy": copy,
            "snapshot_url": ad.snapshot_url,
        })
        for product_id, overlap in matches:
            current = matched_scores.get(product_id)
            if current is None or score > current["longevity_score"]:
                product = product_by_id[product_id]
                matched_scores[product_id] = {
                    "product_id": product_id,
                    "title": str(product.get("title", ""))[:200],
                    "longevity_score": score,
                    "observed_longest_ad_age_days": age_days,
                    "matched_ad_ids": [library_id],
                    "matched_terms": overlap,
                    "review_signal": "public_active_ad_copy_overlap_and_start_age_only",
                }
            elif library_id not in current["matched_ad_ids"]:
                current["matched_ad_ids"].append(library_id)
        if not matched_ids:
            suggestions.append({
                "suggestion_id": library_id,
                "status": "awaiting_product_research",
                "source": "official_meta_ad_library",
                "country": "DE",
                "page_name": str(ad.page_name)[:160],
                "started_at": ad.started_at,
                "observed_age_days": age_days,
                "longevity_score": score,
                "search_terms": sorted(observed["terms"]),
                "ad_copy": copy,
                "snapshot_url": ad.snapshot_url,
                "product_url": None,
                "price_verified": False,
                "availability_verified": False,
                "needs_manual_product_match": True,
            })

    ranked_ads.sort(key=lambda item: (-item["longevity_score"], item["library_id"]))
    matched_products = sorted(
        matched_scores.values(),
        key=lambda item: (-item["longevity_score"], item["title"].casefold(), item["product_id"]),
    )
    result: dict[str, Any] = {
        "status": "partial" if errors else "completed",
        "source": "official_meta_ad_library",
        "country": "DE",
        "search_terms": terms,
        "active_ads_checked": len(ads_by_id),
        "trend_ads": ranked_ads[:50],
        "matched_products": matched_products[:50],
        "queued_suggestions": suggestions[:50],
        "suggestion_count": len(suggestions),
        "errors": errors,
        "evidence_limit": "Ad longevity and public copy do not prove sales, profitability or actual product demand.",
        "campaign_writes_performed": False,
    }
    if store is not None:
        try:
            await store.record(_TREND_AUDIT_KIND, result)
            result["queue_status"] = "persisted_for_review"
        except (OSError, sqlite3.Error):
            result["queue_status"] = "audit_write_failed"
    else:
        result["queue_status"] = "audit_unavailable"
    _TREND_MEMORY_CACHE = (datetime.now(UTC), dict(result))
    return result


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
    } or parsed.username or parsed.password or parsed.port not in {None, 443}):
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
        try:
            trends = await _scan_meta_trends([], env)
        except Exception:
            trends = {"status": "partial", "reason": "META_AD_LIBRARY_SCAN_FAILED"}
        result = {
            "status": "blocked",
            "reason": str(exc) if isinstance(exc, ValueError) else "PRODUCT_FEED_READ_FAILED",
            "products_checked": 0,
            "candidates": [],
            "competitor_trends": trends,
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    report = ProductFeedManager().parse(payload)
    products = [product.model_dump(mode="json") for product in report.products]
    if not products:
        try:
            trends = await _scan_meta_trends([], env)
        except Exception:
            trends = {"status": "partial", "reason": "META_AD_LIBRARY_SCAN_FAILED"}
        result = {
            "status": "blocked",
            "reason": "NO_VALID_FEED_PRODUCTS",
            "rejected_rows": report.rejected_rows,
            "candidates": [],
            "competitor_trends": trends,
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    try:
        trends = await _scan_meta_trends(products, env)
    except Exception:
        logger.warning("product_hunter_meta_trend_scan_failed", exc_info=True)
        trends = {"status": "partial", "reason": "META_AD_LIBRARY_SCAN_FAILED"}

    try:
        costs = _read_verified_costs(env)
    except (OSError, sqlite3.Error):
        result = {
            "status": "blocked",
            "reason": "UNIT_COST_DATABASE_UNAVAILABLE",
            "products_checked": len(products),
            "rejected_rows": report.rejected_rows,
            "candidates": [],
            "competitor_trends": trends,
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    candidates, selection = select_cost_candidates(
        products, costs, now=datetime.now(UTC)
    )
    trend_by_id = {
        str(item.get("product_id")): item
        for item in trends.get("matched_products", [])
        if isinstance(item, dict)
    }
    for candidate in candidates:
        trend = trend_by_id.get(str(candidate.get("id", "")))
        if trend:
            candidate["meta_trend_score"] = trend["longevity_score"]
            candidate["meta_trend_age_days"] = trend["observed_longest_ad_age_days"]
            candidate["meta_trend_ad_ids"] = trend["matched_ad_ids"]
    limit = max(1, min(int(env.get("PILOT_HUNTER_LIMIT", "10")), 10))
    result = {
        "status": "selected" if candidates else "no_eligible_products",
        "source_format": report.source_format,
        "products_checked": len(products),
        "invalid_feed_rows": report.rejected_rows,
        "selection": selection,
        "candidates": candidates[:limit],
        "candidate_count_returned": min(len(candidates), limit),
        "competitor_trends": trends,
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
                "meta_trend_status": trends.get("status"),
                "meta_active_ads_checked": trends.get("active_ads_checked", 0),
                "meta_matched_products": len(trends.get("matched_products", [])),
                "meta_suggestions_queued": trends.get("suggestion_count", 0),
                "meta_suggestion_queue_status": trends.get("queue_status"),
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
