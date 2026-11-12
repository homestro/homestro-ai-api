"""Homestro worker: catalog ranking, DE/AT trend matching, SEO and review-only ad drafts."""
from __future__ import annotations

from typing import Any, Mapping, Sequence
from .erazer_priority import HANDLE, REFERENCE_PRICE_EUR, is_erazer_xp6, rank_products, relevance_boost, shopify_video_url


class HomestroAgent:
    agent_id = "homestro"
    mission = "Shopify catalog, Erazer XP6 SEO/Trends priority and review-only ad drafts."

    def rank(self, products: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        return rank_products(products)

    def match_trends(self, product: Mapping[str, Any], trends: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        ranked = []
        for item in trends:
            query = str(item.get("query") or item.get("title") or "")
            boost, groups = relevance_boost(product, query)
            ranked.append({**dict(item), "priority_boost": boost, "matched_groups": list(groups)})
        ranked.sort(key=lambda item: (-float(item["priority_boost"]), -float(item.get("score") or 0)))
        return ranked[:20]

    def ad_draft(self, product: Mapping[str, Any]) -> dict[str, Any]:
        flagship = is_erazer_xp6(product)
        video = shopify_video_url(product)
        if flagship and not video:
            return {"status": "blocked", "product_handle": product.get("handle") or HANDLE,
                    "reason": "FLAGSHIP_EXISTING_SHOPIFY_VIDEO_REQUIRED", "dry_run": True, "spend_eur": 0.0}
        price = product.get("price") or product.get("priceEUR")
        try:
            price = float(price)
        except (TypeError, ValueError):
            price = REFERENCE_PRICE_EUR if flagship else None
        return {"status": "draft_only", "featured_product": bool(flagship),
                "product_handle": product.get("handle") or HANDLE if flagship else product.get("handle"),
                "price_eur": price, "creative": {"source": "shopify", "video_url": video} if video else None,
                "dry_run": True, "execution_enabled": False, "spend_eur": 0.0}

    def cycle_brief(self) -> dict[str, Any]:
        return {"status": "review_draft", "priority_product": "Erazer XP6",
                "priority_handle": HANDLE, "reference_price_eur": REFERENCE_PRICE_EUR,
                "market_scope": ["DE", "AT"],
                "video_policy": "reuse_existing_shopify_asset_only",
                "live_shopify_reads_performed": False, "campaign_writes": False,
                "dry_run": True, "cost_eur": 0.0}

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if task_type == "rank_products":
            return {"products": self.rank(payload.get("products", [])), "priority_handle": HANDLE}
        if task_type == "ad_draft":
            return self.ad_draft(payload.get("product") or {})
        if task_type == "prepare_pillar_brief":
            return self.cycle_brief()
        if task_type == "trend_match":
            return {"trends": self.match_trends(payload.get("product") or {}, payload.get("trends", []))}
        raise ValueError("HOMESTRO_TASK_NOT_SUPPORTED")
