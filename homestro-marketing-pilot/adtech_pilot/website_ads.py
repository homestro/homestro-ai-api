"""Existing Shopify image/link creatives; no catalog or generation dependency."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from .feed_manager import FeedProduct


def website_story(products: list[dict[str, Any]], page_id: str) -> tuple[dict[str, Any], list[str]]:
    selected: list[FeedProduct] = []
    seen: set[str] = set()
    for raw in products:
        try:
            product = FeedProduct.model_validate(raw)
        except ValueError:
            continue
        if (product.availability != "in_stock" or product.currency != "EUR" or not product.image_link
                or urlsplit(product.image_link).hostname not in {"cdn.shopify.com", "homestro.de", "www.homestro.de"}
                or product.link in seen or raw.get("status", "ACTIVE") != "ACTIVE"
                or any(tag.lower() in {"homestro-ai-rejected", "homestro-qa-rejected"} for tag in product.tags)):
            continue
        seen.add(product.link)
        selected.append(product)
        if len(selected) == 10:
            break
    if not selected:
        raise ValueError("NO_ELIGIBLE_WEBSITE_PRODUCTS")
    first = selected[0]
    data: dict[str, Any] = {"link": first.link,
        "message": "Entdecke praktische Produkte für deinen Alltag. Details, Varianten und aktuelle Preise findest du bei Homestro.",
        "call_to_action": {"type": "SHOP_NOW", "value": {"link": first.link}}}
    if len(selected) == 1:
        data.update({"picture": first.image_link, "name": first.title[:40]})
    else:
        data.update({"name": "Produkte bei Homestro entdecken", "child_attachments": [{
            "link": product.link, "picture": product.image_link, "name": product.title[:40],
            "call_to_action": {"type": "SHOP_NOW", "value": {"link": product.link}},
        } for product in selected], "multi_share_end_card": False})
    return {"page_id": page_id, "link_data": data}, [product.id for product in selected]
