"""Canonical Erazer XP6 matching shared by the Python workforce and Node marketing pilot."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

_CONFIG = json.loads(Path(__file__).with_name("erazer_priority.json").read_text(encoding="utf-8"))
TITLE = _CONFIG["title"]
HANDLE = _CONFIG["handle"]
LEGACY_HANDLES = tuple(_CONFIG.get("legacyHandles", ()))
REFERENCE_PRICE_EUR = float(_CONFIG["referencePriceEUR"])
TREND_GROUPS = {key: tuple(value) for key, value in _CONFIG["trendGroups"].items()}


def _text(value: Any) -> str:
    return str(value or "").strip().casefold()


def is_erazer_xp6(product: Mapping[str, Any] | None) -> bool:
    """Accept Shopify Admin, marketing snapshot, and feed naming conventions."""
    if not isinstance(product, Mapping):
        return False
    handle = _text(product.get("handle"))
    url = _text(product.get("url") or product.get("onlineStoreUrl"))
    title = _text(product.get("title"))
    localized = product.get("localized") or product.get("germanCopy") or {}
    localized_title = _text(localized.get("title")) if isinstance(localized, Mapping) else ""
    handles = {HANDLE, *LEGACY_HANDLES}
    return (
        handle in handles
        or any(url.rstrip("/").endswith("/products/" + candidate) for candidate in handles)
        or bool(re.search(r"\berazer[\s-]+xp6\b", title))
        or bool(re.search(r"\berazer[\s-]+xp6\b", localized_title))
    )


def shopify_video_url(product: Mapping[str, Any] | None) -> str | None:
    """Return only a ready Shopify video source; never synthesize a replacement."""
    if not isinstance(product, Mapping):
        return None

    def shopify_cdn_url(value: Any) -> str | None:
        if not isinstance(value, str) or not value.startswith("https://"):
            return None
        return value if urlparse(value).hostname == "cdn.shopify.com" else None

    explicit = product.get("video_url")
    if (shopify_explicit := shopify_cdn_url(explicit)):
        return shopify_explicit
    media = product.get("media") or []
    if isinstance(media, Mapping):
        media = media.get("nodes") or media.get("edges") or []
    if not isinstance(media, Sequence) or isinstance(media, (str, bytes)):
        return None
    for item in media:
        if not isinstance(item, Mapping):
            continue
        node = item.get("node") if isinstance(item.get("node"), Mapping) else item
        kind = str(node.get("mediaContentType") or node.get("kind") or "").upper()
        state = str(node.get("status") or "").upper()
        if kind != "VIDEO" or state not in {"READY", ""}:
            continue
        sources = [node.get("originalSource"), *(node.get("sources") or [])]
        for source in sources:
            if not isinstance(source, Mapping):
                continue
            url = source.get("url")
            media_type = str(source.get("mimeType") or "").lower()
            fmt = str(source.get("format") or "").lower()
            if (shopify_url := shopify_cdn_url(url)) and (media_type == "video/mp4" or fmt == "mp4"):
                return shopify_url
    return None


def relevance_boost(product: Mapping[str, Any], query: str) -> tuple[float, tuple[str, ...]]:
    """Give the flagship defined category boosts without asserting product features."""
    if not is_erazer_xp6(product):
        return 0.0, ()
    folded = unicodedata.normalize("NFKD", str(query or "").casefold())
    folded = "".join(character for character in folded if not unicodedata.combining(character))
    normalized = re.sub(r"[^a-z0-9]+", " ", folded).strip()
    tokens = set(normalized.split())
    exact = {"erazer", "xp6"}.issubset(tokens)
    matched = tuple(name for name, words in TREND_GROUPS.items() if tokens.intersection(words))
    return (float(_CONFIG["exactMatchBoost"]) if exact else min(0.6, len(matched) * float(_CONFIG["trendBoost"]))), matched


def rank_products(products: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Stable flagship-first ranking, then descending existing numeric score."""
    def score(item: Mapping[str, Any]) -> float:
        value = item.get("score", 0)
        try:
            number = float(value)
            return number if number == number and abs(number) != float("inf") else 0.0
        except (TypeError, ValueError):
            return 0.0

    indexed = list(enumerate(products))
    indexed.sort(key=lambda pair: (not is_erazer_xp6(pair[1]), -score(pair[1]), pair[0]))
    return [dict(product) for _, product in indexed]
