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
from urllib.parse import quote, urlsplit

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



_TREND_SCORE_KEYS = (
    "trend_score", "trendScore", "score", "interest", "interestScore",
    "popularity", "popularityScore", "growth", "growthRate", "growthPercent",
)


def _trend_terms(products: list[dict[str, Any]], limit: int = 10) -> list[str]:
    """Build bounded German product queries, preferring concrete catalog titles."""
    terms: list[str] = []
    seen: set[str] = set()
    for product in products:
        title = re.sub(r"\s+", " ", str(product.get("title") or "")).strip()
        category = str(product.get("product_type") or "").strip()
        term = title[:80] if title else category[:80]
        key = term.casefold()
        if term and key not in seen:
            terms.append(term)
            seen.add(key)
        if len(terms) >= limit:
            break
    if not terms:
        terms = ["Wohnaccessoires", "Küche", "Haushalt", "Garten"]
    return terms


def _score_trend_record(row: dict[str, Any]) -> float | None:
    """Normalize common actor score shapes to 0-100; rising series score above baseline."""
    value: Any = next((row.get(key) for key in _TREND_SCORE_KEYS if row.get(key) is not None), None)
    if isinstance(value, list):
        value = value[-2:] if value else None
        if isinstance(value, list):
            try:
                previous, latest = float(value[0]), float(value[-1])
                return round(max(0.0, min(100.0, 50.0 + (latest - previous) * 2.0)), 2)
            except (TypeError, ValueError):
                value = None
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float("nan")
    if number != number:
        series = row.get("values") or row.get("timelineData") or row.get("interest_over_time")
        if isinstance(series, list) and len(series) >= 2:
            points = []
            for item in series[-2:]:
                candidate = item.get("value") if isinstance(item, dict) else item
                if isinstance(candidate, list) and candidate:
                    candidate = candidate[0]
                try:
                    points.append(float(candidate))
                except (TypeError, ValueError):
                    return None
            number = 50.0 + (points[-1] - points[0]) * 2.0
        else:
            return None
    key = next((key for key in _TREND_SCORE_KEYS if row.get(key) is not None), "")
    if key.lower() in {"growth", "growthrate", "growthpercent"}:
        number = 50.0 + number / 2.0
    return round(max(0.0, min(100.0, number)), 2)


def _trend_label(row: dict[str, Any]) -> str:
    for key in ("keyword", "searchTerm", "search_term", "query", "productName", "product", "title", "name", "term"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:200]
    return ""


def _match_trend_products(label: str, products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    label_tokens = _tokens(label)
    normalized_label = re.sub(r"\s+", " ", label.casefold()).strip()
    matches = []
    for product in products:
        title = str(product.get("title") or "")
        category = str(product.get("product_type") or product.get("google_product_category") or "")
        combined = f"{title} {category}"
        overlap = len(label_tokens.intersection(_tokens(combined)))
        exact_query = bool(normalized_label and normalized_label in re.sub(r"\s+", " ", combined.casefold()))
        if exact_query or overlap >= 2:
            matches.append(product)
    return matches


async def _run_apify_actor(
    source: str, products: list[dict[str, Any]], env: dict[str, str]
) -> dict[str, Any]:
    """Run a configured read-only trend actor; actor-specific input is optional JSON."""
    token = (env.get("APIFY_API_TOKEN") or "").strip()
    actor_id = (env.get(f"APIFY_{source.upper()}_TRENDS_ACTOR_ID") or "").strip()
    if not token:
        return {"status": "skipped", "reason": "APIFY_API_TOKEN_MISSING", "matched_products": [], "signals": []}
    if not actor_id:
        return {"status": "skipped", "reason": f"APIFY_{source.upper()}_TRENDS_ACTOR_ID_MISSING", "matched_products": [], "signals": []}
    terms = _trend_terms(products, _bounded_int(env, "PRODUCT_TRENDS_MAX_TERMS", 10, 20))
    input_name = f"APIFY_{source.upper()}_TRENDS_INPUT_JSON"
    try:
        actor_input = json.loads(env.get(input_name, "{}") or "{}")
        if not isinstance(actor_input, dict):
            raise ValueError
    except (TypeError, ValueError):
        return {"status": "partial", "reason": f"{input_name}_INVALID", "matched_products": [], "signals": []}
    defaults = (
        {"country": "DE", "countryCode": "DE", "category": "Home & Living", "searchTerms": terms, "keywords": terms}
        if source == "tiktok"
        else {"geo": "DE", "country": "DE", "keywords": terms, "searchTerms": terms, "timeRange": "today 3-m"}
    )
    defaults.update(actor_input)
    actor_path = quote(actor_id, safe="~")
    url = f"https://api.apify.com/v2/acts/{actor_path}/run-sync-get-dataset-items"
    errors: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=5), follow_redirects=False) as client:
            response = await client.post(url, params={"token": token, "clean": "true", "limit": "100"}, json=defaults)
            response.raise_for_status()
            rows = response.json()
        if not isinstance(rows, list):
            raise ValueError("invalid_dataset_shape")
    except httpx.HTTPStatusError as exc:
        errors.append(f"APIFY_HTTP_{exc.response.status_code}")
        return {"status": "partial", "reason": errors[0], "matched_products": [], "signals": []}
    except (httpx.HTTPError, ValueError, TypeError):
        return {"status": "partial", "reason": "APIFY_REQUEST_OR_RESPONSE_FAILED", "matched_products": [], "signals": []}
    except Exception:
        logger.warning("product_hunter_%s_trend_actor_failed", source, exc_info=True)
        return {"status": "partial", "reason": "APIFY_ACTOR_FAILED", "matched_products": [], "signals": []}

    signals: list[dict[str, Any]] = []
    scores: dict[str, dict[str, Any]] = {}
    product_by_id = {str(p.get("id")): p for p in products if str(p.get("id", "")).strip()}
    for row in rows[:100]:
        if not isinstance(row, dict):
            continue
        label = _trend_label(row)
        score = _score_trend_record(row)
        if score is None:
            continue
        matched = _match_trend_products(label, products)
        signal = {"label": label[:200], "score": score, "country": "DE", "source": source}
        signals.append({**signal, "matched_product_ids": [str(p.get("id")) for p in matched]})
        for product in matched:
            product_id = str(product.get("id"))
            current = scores.get(product_id)
            if current is None or score > current["score"]:
                scores[product_id] = {
                    "product_id": product_id,
                    "title": str(product.get("title", ""))[:200],
                    "score": score,
                    "signal_label": label[:200],
                }
    return {
        "status": "partial" if errors else "completed",
        "source": "tiktok_creative_center_ads" if source == "tiktok" else "google_trends",
        "country": "DE",
        "terms": terms,
        "signals_checked": len(rows),
        "signals": signals[:100],
        "matched_products": sorted(scores.values(), key=lambda x: (-x["score"], x["title"].casefold()))[:100],
        "errors": errors,
    }


async def _scan_tiktok_trends(products: list[dict[str, Any]], env: dict[str, str]) -> dict[str, Any]:
    return await _run_apify_actor("tiktok", products, env)


async def _scan_google_trends(products: list[dict[str, Any]], env: dict[str, str]) -> dict[str, Any]:
    return await _run_apify_actor("google", products, env)


async def _scan_all_trends(products: list[dict[str, Any]], env: dict[str, str]) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for name, scanner in (
        ("meta", _scan_meta_trends),
        ("tiktok", _scan_tiktok_trends),
        ("google", _scan_google_trends),
    ):
        try:
            results[name] = await scanner(products, env)
        except Exception:
            logger.warning("product_hunter_%s_trend_scan_failed", name, exc_info=True)
            results[name] = {"status": "partial", "reason": f"{name.upper()}_TREND_SCAN_FAILED", "matched_products": []}
    return {
        "status": "partial" if any(item.get("status") == "partial" for item in results.values()) else "completed",
        "source": "multi_source_product_trends",
        "country": "DE",
        "active_ads_checked": results["meta"].get("active_ads_checked", 0),
        "matched_products": results["meta"].get("matched_products", []),
        "queued_suggestions": results["meta"].get("queued_suggestions", []),
        "suggestion_count": results["meta"].get("suggestion_count", 0),
        "sources": results,
    }


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
    """Read feed, collect optional DE trend signals, then select verified-cost candidates."""
    env = dict(os.environ if env is None else env)
    try:
        payload = await _read_feed(env)
    except (OSError, ValueError, httpx.HTTPError) as exc:
        trends = await _scan_all_trends([], env)
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
        trends = await _scan_all_trends([], env)
        result = {
            "status": "blocked",
            "reason": "NO_VALID_FEED_PRODUCTS",
            "rejected_rows": report.rejected_rows,
            "candidates": [],
            "competitor_trends": trends,
        }
        logger.info("product_hunter %s", json.dumps(result, separators=(",", ":")))
        return result

    trends = await _scan_all_trends(products, env)
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

    candidates, selection = select_cost_candidates(products, costs, now=datetime.now(UTC))
    sources = trends.get("sources", {})
    score_by_id: dict[str, dict[str, float]] = {}
    for source in ("meta", "tiktok", "google"):
        for item in sources.get(source, {}).get("matched_products", []):
            if isinstance(item, dict):
                product_id = str(item.get("product_id", "")).strip()
                score_key = "longevity_score" if source == "meta" else "score"
                if product_id:
                    score_by_id.setdefault(product_id, {})[source] = float(item.get(score_key, 0) or 0)

    for candidate in candidates:
        scores = score_by_id.get(str(candidate.get("id", "")), {})
        if "meta" in scores:
            candidate["meta_trend_score"] = scores["meta"]
        if "tiktok" in scores:
            candidate["tiktok_trend_score"] = scores["tiktok"]
        if "google" in scores:
            candidate["google_trend_score"] = scores["google"]
        if scores:
            candidate["trend_priority_score"] = round(sum(scores.values()) / len(scores), 2)
    candidates.sort(key=lambda item: -float(item.get("trend_priority_score", 0)))
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
                "trend_source_status": {
                    name: value.get("status")
                    for name, value in sources.items()
                },
                "trend_signals": {
                    name: value.get("signals_checked", 0)
                    for name, value in sources.items()
                },
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
