"""Existing Shopify image/link creatives; no catalog or generation dependency."""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from .feed_manager import FeedProduct

OWNER_EXCLUDED_HANDLES = {'pet-combs-knot-opening-combs-massage-combs-electric-steam-spray-brushes-de-floating-pet-products-cat-combs'}


def product_path(value):
    return unquote(urlsplit(str(value)).path).rstrip('/').casefold()


_VARIANT_QUERY_KEYS = {
    'variant', 'variant_id', 'selected_variant', 'option', 'size', 'color',
    'colour', 'sku', 'option1', 'option2', 'option3',
}
_TRACKING_QUERY_KEYS = {'fbclid', 'gclid', 'msclkid', 'pilot_ref', 'ref', 'source', 'campaign', 'ad'}


def product_variant_identity(product, fallback_id=None):
    """Identify a feed variant without treating tracking tags as distinct items."""
    link = str(product.get('link') or '')
    path = product_path(link)
    parameters = tuple(sorted(
        (key.casefold(), value)
        for key, value in parse_qsl(urlsplit(link).query, keep_blank_values=False)
        if (key.casefold() in _VARIANT_QUERY_KEYS or key.casefold().startswith('option_'))
        and key.casefold() not in _TRACKING_QUERY_KEYS
        and not key.casefold().startswith('utm_')
    ))
    if parameters:
        return (path, 'parameters', parameters)
    identity = str(fallback_id or product.get('id') or '').strip()
    if identity:
        return (path, 'id', identity)
    return (path, 'url')


def owner_excluded(product):
    path = product_path(product.get('link', ''))
    text = (path+' '+str(product.get('title') or product.get('name') or '')).casefold()
    return (path.rsplit('/', 1)[-1] in OWNER_EXCLUDED_HANDLES
            or bool(re.search(r'(silikon|silicon).*?(spachtel|spatula)|(spachtel|spatula).*?(silikon|silicon)', text)))


def website_story(products: list[dict[str, Any]], page_id: str) -> tuple[dict[str, Any], list[str]]:
    selected: list[FeedProduct] = []
    seen = set()
    for raw in products:
        try:
            product = FeedProduct.model_validate(raw)
        except ValueError:
            continue
        if (product.availability != "in_stock" or product.currency != "EUR" or not product.image_link
                or urlsplit(product.image_link).hostname not in {"cdn.shopify.com", "homestro.de", "www.homestro.de"}
                or product_variant_identity(raw, product.id) in seen or owner_excluded(raw) or raw.get("status", "ACTIVE") != "ACTIVE"
                or any(tag.lower() in {"homestro-ai-rejected", "homestro-qa-rejected"} for tag in product.tags)):
            continue
        seen.add(product_variant_identity(raw, product.id))
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
