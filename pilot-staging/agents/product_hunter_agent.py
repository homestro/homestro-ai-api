"""Read-only Shopify catalog scout for the Homestro staging pilot.

The scheduled scan never changes Shopify. It can enqueue at most one
creative task per daily run, and only when the explicit queue flag is enabled.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import redis

from celery_app import app

SHOPIFY_API_VERSION = os.getenv("SHOPIFY_API_VERSION", "2026-10")
SHOPIFY_PAGE_SIZE = 50
MAX_PRODUCTS_PER_SCAN = 2500
DEFAULT_BESTSELLER_TAGS = {
    "bestseller",
    "best-seller",
    "best_seller",
    "top seller",
    "top-seller",
}
SHOPIFY_PRODUCTS_QUERY = """
query ProductHunterProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id
      title
      handle
      onlineStoreUrl
      description
      status
      tags
      totalInventory
      updatedAt
      featuredImage { url altText }
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


class _PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.parts.append(data.strip())


def _plain_text(value: Any, max_chars: int = 6000) -> str:
    if not isinstance(value, str):
        return ""
    parser = _PlainText()
    try:
        parser.feed(value)
        parser.close()
        result = " ".join(parser.parts)
    except Exception:
        result = html.unescape(re.sub(r"<[^>]*>", " ", value))
    return re.sub(r"\s+", " ", result).strip()[:max_chars]


def _required_shopify_config() -> tuple[str, str, str] | None:
    domain = (os.getenv("SHOPIFY_SHOP_DOMAIN") or "").strip().lower().rstrip("/")
    token = (os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN") or "").strip()
    version = (os.getenv("SHOPIFY_API_VERSION") or "2026-10").strip()
    # Admin API calls must target the store's canonical myshopify.com host.
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.myshopify\.com", domain):
        return None
    if not token or not re.fullmatch(r"20\d{2}-\d{2}", version):
        return None
    return domain, token, version


def _shopify_page(
    domain: str,
    token: str,
    version: str,
    after: str | None,
) -> dict[str, Any]:
    endpoint = f"https://{domain}/admin/api/{version}/graphql.json"
    body = json.dumps(
        {
            "query": SHOPIFY_PRODUCTS_QUERY,
            "variables": {"first": SHOPIFY_PAGE_SIZE, "after": after},
        }
    ).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Shopify-Access-Token": token,
        },
        method="POST",
    )

    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("errors"):
                raise RuntimeError("Shopify GraphQL rejected the catalog query; check read_products scope.")
            data = payload.get("data", {}).get("products")
            if not isinstance(data, dict):
                raise RuntimeError("Shopify returned an invalid products response.")
            return data
        except HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                time.sleep(min(2 ** attempt, 4))
                continue
            raise RuntimeError(f"Shopify catalog request failed with HTTP {exc.code}.") from None
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt < 2:
                time.sleep(min(2 ** attempt, 4))
                continue
            raise RuntimeError(f"Shopify catalog request failed ({type(exc).__name__}).") from None
    raise RuntimeError("Shopify catalog request failed after bounded retries.")


def _normalise_product(raw: Any, bestseller_tags: set[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if raw.get("status") != "ACTIVE":
        return None
    product_id = raw.get("id")
    title = raw.get("title")
    inventory = raw.get("totalInventory")
    image = raw.get("featuredImage")
    price_range = raw.get("priceRangeV2")
    price_info = (
        price_range.get("minVariantPrice", {})
        if isinstance(price_range, dict)
        else {}
    )
    try:
        price = float(price_info.get("amount"))
        stock = int(inventory)
    except (TypeError, ValueError):
        return None
    if (
        not isinstance(product_id, str)
        or not product_id.startswith("gid://shopify/Product/")
        or not isinstance(title, str)
        or not title.strip()
        or not isinstance(image, dict)
        or not isinstance(image.get("url"), str)
        or price <= 0
        or stock <= 0
    ):
        return None

    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    normalized_tags = {str(tag).strip().casefold() for tag in tags}
    matched_bestseller_tags = sorted(normalized_tags.intersection(bestseller_tags))
    description = _plain_text(raw.get("description"))
    return {
        "product_id": product_id,
        "title": title.strip()[:300],
        "handle": str(raw.get("handle") or "").strip(),
        "product_url": str(raw.get("onlineStoreUrl") or "").strip(),
        "image_url": str(image.get("url") or "").strip(),
        "description": description,
        "features": [],
        "audience": "",
        "stock": stock,
        "price": price,
        "currency": str(price_info.get("currencyCode") or ""),
        "has_image": True,
        "updated_at": str(raw.get("updatedAt") or ""),
        "bestseller": bool(matched_bestseller_tags),
        "bestseller_tags": matched_bestseller_tags,
        "image_alt_present": bool(str(image.get("altText") or "").strip()),
    }


def _priority(product: dict[str, Any], no_active_campaign_ids: set[str]) -> tuple[int, int, str]:
    score = 0
    if product["bestseller"]:
        score += 100
    if product["product_id"] in no_active_campaign_ids:
        score += 50
    # These small tie-breakers favor usable listings, not sales performance.
    score += min(product["stock"], 100) // 10
    score += 5 if product["image_alt_present"] else 0
    return score, product["stock"], product["updated_at"]


def _json_id_set(name: str) -> set[str]:
    raw = os.getenv(name, "[]")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"{name} muss ein JSON-Array aus Shopify-Produkt-IDs sein.") from None
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise RuntimeError(f"{name} muss ein JSON-Array aus Shopify-Produkt-IDs sein.")
    return set(values)


def _redis_client() -> redis.Redis:
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL fehlt.")
    return redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=5)


@app.task(
    bind=True,
    name="product_hunter.scan_shopify_catalog",
    acks_late=False,
    max_retries=0,
)
def scan_shopify_catalog(self) -> dict[str, Any]:
    """Daily read-only catalog scan; optional single-product creative dispatch."""
    run_at = datetime.now(timezone.utc).isoformat()
    if os.getenv("PRODUCT_HUNTER_ENABLED", "false").casefold() not in {"1", "true", "yes", "on"}:
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "paused",
            "reason": "PRODUCT_HUNTER_ENABLED is not true",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }

    config = _required_shopify_config()
    if config is None:
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "blocked",
            "reason": "Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, and SHOPIFY_API_VERSION",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }
    domain, token, version = config

    queue_enabled = os.getenv("PRODUCT_HUNTER_AUTO_QUEUE", "false").casefold() in {
        "1", "true", "yes", "on"
    }
    if queue_enabled and not os.getenv("OPENAI_API_KEY"):
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "blocked",
            "reason": "OPENAI_API_KEY is required before enabling creative dispatch",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }

    seo_chain_enabled = os.getenv("SEO_WORKFLOW_ENABLED", "false").casefold() in {
        "1", "true", "yes", "on"
    }
    if queue_enabled and seo_chain_enabled and os.getenv("SEO_PUBLISHER_READY", "false").casefold() not in {
        "1", "true", "yes", "on"
    }:
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "blocked",
            "reason": "SEO_PUBLISHER_READY must be true before paid creative-to-page dispatch",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }
    if queue_enabled and seo_chain_enabled and not os.getenv("SEO_PUBLIC_BASE_URL", "").strip():
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "blocked",
            "reason": "SEO_PUBLIC_BASE_URL is required before creative-to-page dispatch",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }

    cache = _redis_client()
    day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    scan_lock = f"pilot_staging:product_hunter:daily_scan:{day_key}"
    if not cache.set(scan_lock, "started", nx=True, ex=60 * 60 * 23):
        return {
            "task": "product_hunter.scan_shopify_catalog",
            "status": "already_scanned_today",
            "shopify_read": False,
            "creative_tasks_queued": 0,
            "run_at": run_at,
        }

    bestsellers = {
        tag.strip().casefold()
        for tag in os.getenv("PRODUCT_HUNTER_BESTSELLER_TAGS", "").split(",")
        if tag.strip()
    } or DEFAULT_BESTSELLER_TAGS
    no_active_campaign_ids = _json_id_set("PRODUCT_HUNTER_NO_ACTIVE_CAMPAIGN_PRODUCT_IDS")

    products: list[dict[str, Any]] = []
    scanned_count = 0
    cursor: str | None = None
    has_next_page = True
    while has_next_page and scanned_count < MAX_PRODUCTS_PER_SCAN:
        page = _shopify_page(domain, token, version, cursor)
        for raw in page.get("nodes", []):
            if scanned_count >= MAX_PRODUCTS_PER_SCAN:
                break
            scanned_count += 1
            product = _normalise_product(raw, bestsellers)
            if product:
                products.append(product)
        page_info = page.get("pageInfo") or {}
        has_next_page = bool(page_info.get("hasNextPage")) and scanned_count < MAX_PRODUCTS_PER_SCAN
        cursor = page_info.get("endCursor")
        if has_next_page and not cursor:
            raise RuntimeError("Shopify pagination returned hasNextPage without a cursor.")

    eligible = [
        product
        for product in products
        if product["bestseller"] or product["product_id"] in no_active_campaign_ids
    ]
    eligible.sort(key=lambda item: _priority(item, no_active_campaign_ids), reverse=True)

    selected = None
    queue_task_id = None
    if queue_enabled:
        if len(eligible) > 0:
            for candidate in eligible:
                product_key = hashlib.sha256(candidate["product_id"].encode("utf-8")).hexdigest()
                dedupe_key = f"pilot_staging:product_hunter:creative_queued:{product_key}"
                if cache.get(dedupe_key):
                    continue
                selected = candidate
                # Claim this product before enqueueing so overlapping scans cannot duplicate it.
                claimed = cache.set(dedupe_key, "dispatching", nx=True, ex=180 * 24 * 60 * 60)
                if not claimed:
                    selected = None
                    continue
                try:
                    payload = {
                        "product_id": candidate["product_id"],
                        "title": candidate["title"],
                        "description": candidate["description"],
                        "handle": candidate["handle"],
                        "product_url": candidate["product_url"],
                        "image_url": candidate["image_url"],
                        "price": candidate["price"],
                        "currency": candidate["currency"],
                        "features": candidate["features"],
                        "audience": candidate["audience"],
                    }
                    if seo_chain_enabled:
                        if not candidate["handle"] or not candidate["product_url"]:
                            cache.delete(dedupe_key)
                            selected = None
                            continue
                        from agents.seo_geo_agent import enqueue_creative_to_page_chain

                        queued = enqueue_creative_to_page_chain.delay(payload)
                    else:
                        from agents.kreativni_agent import generate_creative

                        queued = generate_creative.delay(payload)
                    queue_task_id = queued.id
                    cache.set(dedupe_key, queue_task_id or "queued", ex=180 * 24 * 60 * 60)
                except Exception:
                    cache.delete(dedupe_key)
                    raise RuntimeError("Creative task could not be queued; retry only after checking Celery state.") from None
                break
    elif eligible:
        selected = eligible[0]

    return {
        "task": "product_hunter.scan_shopify_catalog",
        "status": "queued" if queue_task_id else "candidate_found" if selected else "no_candidate",
        "run_at": run_at,
        "shopify_read": True,
        "shopify_write": False,
        "products_scanned": scanned_count,
        "eligible_products": len(eligible),
        "selection_reason": (
            "bestseller_tag"
            if selected and selected["bestseller"]
            else "provided_no_active_campaign_snapshot"
            if selected
            else None
        ),
        "selected_product": (
            {
                "product_id": selected["product_id"],
                "title": selected["title"],
                "stock": selected["stock"],
                "price": selected["price"],
                "currency": selected["currency"],
                "has_image": selected["has_image"],
                "campaign_status": (
                    "inactive"
                    if selected["product_id"] in no_active_campaign_ids
                    else "unknown"
                ),
            }
            if selected
            else None
        ),
        "creative_task_id": queue_task_id,
        "creative_tasks_queued": 1 if queue_task_id else 0,
        "auto_queue_enabled": queue_enabled,
        "shopify_write_performed": False,
    }
