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



# External trend sources are read-only. Apify actor launches can incur charges, so
# they remain disabled unless the operator explicitly enables paid runs.
_EXTERNAL_TREND_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
_TRENDS_STOPWORDS = _TREND_STOPWORDS | {"home", "living", "produkt", "produkte", "artikel"}


def _rank_keyword_trends(
    products: list[dict[str, Any]], trends: list[dict[str, Any]], *, source: str
) -> list[dict[str, Any]]:
    """Match observed trend phrases to catalog text; this never creates candidates."""
    ranked: dict[str, dict[str, Any]] = {}
    for trend in trends:
        phrase = str(trend.get("keyword") or "").strip()[:160]
        if not phrase:
            continue
        trend_tokens = _tokens(phrase) - _TRENDS_STOPWORDS
        if not trend_tokens:
            continue
        try:
            source_score = max(0, min(100, int(trend.get("score", 0))))
        except (TypeError, ValueError):
            source_score = 0
        for product in products:
            product_id = str(product.get("id") or "").strip()
            if not product_id:
                continue
            text_value = " ".join(
                str(product.get(key) or "")
                for key in ("title", "product_type", "google_product_category", "tags")
            )
            overlap = trend_tokens & (_tokens(text_value) - _TRENDS_STOPWORDS)
            if not overlap:
                continue
            row = ranked.get(product_id)
            if row is None or source_score > row["score"]:
                ranked[product_id] = {
                    "product_id": product_id,
                    "title": str(product.get("title") or "")[:200],
                    "score": source_score,
                    "matched_keywords": [phrase],
                    "source": source,
                    "country": "DE",
                }
            elif phrase not in row["matched_keywords"]:
                row["matched_keywords"].append(phrase)
    return sorted(ranked.values(), key=lambda row: (-row["score"], row["title"].casefold()))[:100]


async def _scan_google_trends(
    products: list[dict[str, Any]], env: dict[str, str]
) -> dict[str, Any]:
    """Read Google's public Trending Now RSS for Germany; failure is non-fatal."""
    interval = _bounded_int(env, "GOOGLE_TRENDS_SCAN_INTERVAL_HOURS", 6, 24)
    cached = _EXTERNAL_TREND_CACHE.get("google")
    now = datetime.now(UTC)
    if cached and (now - cached[0]).total_seconds() < interval * 3600:
        payload = cached[1]
        return {**payload, "cache_hit": True}
    url = "https://trends.google.com/trending/rss?geo=DE&hl=de"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12, connect=5), follow_redirects=False
        ) as client:
            response = await client.get(url, headers={"User-Agent": "HomestroProductHunter/1.0"})
            response.raise_for_status()
        if len(response.content) > 512_000:
            return {"status": "partial", "reason": "GOOGLE_TRENDS_RESPONSE_TOO_LARGE", "matched_products": []}
        root = __import__("xml.etree.ElementTree", fromlist=["ElementTree"]).fromstring(response.content)
        items = root.findall("./channel/item")[:100]
        trends: list[dict[str, Any]] = []
        for rank, item in enumerate(items, start=1):
            title = item.findtext("title", default="").strip()
            if title:
                trends.append({"keyword": title, "score": max(1, 100 - (rank - 1)), "rank": rank})
        result = {
            "status": "completed",
            "source": "google_trends_trending_now_rss",
            "country": "DE",
            "trend_count": len(trends),
            "trends": trends,
            "matched_products": _rank_keyword_trends(products, trends, source="google_trends"),
        }
        _EXTERNAL_TREND_CACHE["google"] = (now, result)
        return result
    except (httpx.HTTPError, ValueError, TypeError, OSError):
        logger.warning("product_hunter_google_trends_unavailable", exc_info=True)
        return {"status": "partial", "reason": "GOOGLE_TRENDS_UNAVAILABLE", "matched_products": []}


async def _scan_tiktok_trends(
    products: list[dict[str, Any]], env: dict[str, str]
) -> dict[str, Any]:
    """Read Germany-scoped Creative Center results from an explicitly configured Apify actor."""
    token = (env.get("APIFY_API_TOKEN") or "").strip()
    actor_id = (env.get("APIFY_TIKTOK_TRENDS_ACTOR_ID") or "").strip()
    if not token or not actor_id:
        return {"status": "skipped", "reason": "APIFY_TIKTOK_TRENDS_NOT_CONFIGURED", "matched_products": []}
    if str(env.get("HOMESTRO_APIFY_ALLOW_PAID_RUNS", "false")).casefold() not in {"1", "true", "yes"}:
        return {"status": "skipped", "reason": "APIFY_PAID_RUNS_DISABLED", "matched_products": []}
    try:
        actor_input = json.loads(env.get("APIFY_TIKTOK_TRENDS_INPUT_JSON", "{}"))
        if not isinstance(actor_input, dict):
            raise ValueError("actor input must be an object")
        actor_input = {
            **actor_input,
            "country": "DE",
            "region": "DE",
            "maxItems": _bounded_int(env, "APIFY_TIKTOK_TRENDS_MAX_ITEMS", 50, 100),
            "searchTerms": _search_terms(products, env),
        }
    except (TypeError, ValueError, json.JSONDecodeError):
        return {"status": "partial", "reason": "APIFY_TIKTOK_TRENDS_INPUT_INVALID", "matched_products": []}
    safe_actor_id = actor_id.replace("/", "~")
    url = f"https://api.apify.com/v2/acts/{safe_actor_id}/run-sync-get-dataset-items"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(45, connect=5), follow_redirects=False
        ) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                params={"format": "json", "limit": actor_input["maxItems"], "timeout": 40},
                json=actor_input,
            )
            response.raise_for_status()
        if len(response.content) > 1_000_000:
            return {"status": "partial", "reason": "APIFY_TIKTOK_RESPONSE_TOO_LARGE", "matched_products": []}
        rows = response.json()
        if not isinstance(rows, list):
            raise ValueError("invalid actor response")
        trends: list[dict[str, Any]] = []
        for rank, row in enumerate(rows[: actor_input["maxItems"]], start=1):
            if not isinstance(row, dict):
                continue
            keyword = next(
                (str(row.get(key)).strip() for key in ("keyword", "hashtag", "title", "searchTerm", "name") if row.get(key)),
                "",
            )
            if keyword:
                try:
                    score = int(row.get("score") or row.get("rank_score") or max(1, 100 - rank))
                except (TypeError, ValueError):
                    score = max(1, 100 - rank)
                trends.append({"keyword": keyword[:160], "score": max(0, min(100, score))})
        return {
            "status": "completed",
            "source": "tiktok_creative_center_via_apify",
            "country": "DE",
            "trend_count": len(trends),
            "trends": trends,
            "matched_products": _rank_keyword_trends(products, trends, source="tiktok_creative_center"),
        }
    except httpx.HTTPStatusError as exc:
        logger.warning("product_hunter_tiktok_trends_http_status=%s", exc.response.status_code)
        return {"status": "partial", "reason": f"APIFY_TIKTOK_HTTP_{exc.response.status_code}", "matched_products": []}
    except (httpx.HTTPError, ValueError, TypeError, OSError):
        logger.warning("product_hunter_tiktok_trends_unavailable", exc_info=True)
        return {"status": "partial", "reason": "APIFY_TIKTOK_TRENDS_UNAVAILABLE", "matched_products": []}


async def _scan_external_trends(
    products: list[dict[str, Any]], env: dict[str, str]
) -> dict[str, Any]:
    """Collect independent optional sources; one provider outage cannot stop the hunter."""
    google, tiktok = await asyncio.gather(
        _scan_google_trends(products, env),
        _scan_tiktok_trends(products, env),
        return_exceptions=True,
    )
    if isinstance(google, Exception):
        google = {"status": "partial", "reason": "GOOGLE_TRENDS_SCAN_FAILED", "matched_products": []}
    if isinstance(tiktok, Exception):
        tiktok = {"status": "partial", "reason": "TIKTOK_TRENDS_SCAN_FAILED", "matched_products": []}
    return {"google_trends": google, "tiktok_trends": tiktok}


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

    external_trends = await _scan_external_trends(products, env)

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
    google_by_id = {
        str(item.get("product_id")): item
        for item in external_trends["google_trends"].get("matched_products", [])
    }
    tiktok_by_id = {
        str(item.get("product_id")): item
        for item in external_trends["tiktok_trends"].get("matched_products", [])
    }
    for candidate in candidates:
        product_id = str(candidate.get("id", ""))
        google = google_by_id.get(product_id)
        tiktok = tiktok_by_id.get(product_id)
        if google:
            candidate["google_trend_score"] = google["score"]
            candidate["google_trend_keywords"] = google["matched_keywords"]
        if tiktok:
            candidate["tiktok_trend_score"] = tiktok["score"]
            candidate["tiktok_trend_keywords"] = tiktok["matched_keywords"]
        candidate["external_trend_priority"] = max(
            google["score"] if google else 0, tiktok["score"] if tiktok else 0
        )
    candidates.sort(key=lambda candidate: -candidate.get("external_trend_priority", 0))
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
        "external_trends": external_trends,
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
                "google_trend_status": external_trends["google_trends"].get("status"),
                "google_trend_matches": len(external_trends["google_trends"].get("matched_products", [])),
                "tiktok_trend_status": external_trends["tiktok_trends"].get("status"),
                "tiktok_trend_matches": len(external_trends["tiktok_trends"].get("matched_products", [])),
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
