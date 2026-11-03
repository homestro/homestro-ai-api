"""Prepare catalog-ad creative plans and provide a fully synthetic mock chain.

No task in this module sends requests to Meta. Live Graph API writes remain
disabled until the staging campaign/ad-set/catalog IDs and a reviewed write
adapter are configured explicitly.
"""

from __future__ import annotations

import os
from typing import Any

from celery import chain

from celery_app import app


def _is_true(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).casefold() in {"1", "true", "yes", "on"}


def _catalog_ad_plan(seo_result: Any, *, mock_mode: bool) -> dict[str, Any]:
    if not isinstance(seo_result, dict):
        return {"status": "blocked", "reason": "SEO_RESULT_REQUIRED"}

    product = seo_result.get("product")
    creative = seo_result.get("creative")
    if not isinstance(product, dict) or not isinstance(creative, dict):
        return {"status": "blocked", "reason": "SEO_RESULT_MISSING_PRODUCT_OR_CREATIVE"}

    product_id = product.get("product_id")
    if not isinstance(product_id, str) or not product_id.startswith("gid://shopify/Product/"):
        return {"status": "blocked", "reason": "SHOPIFY_PRODUCT_ID_INVALID"}

    # Reuse the Phase 2 URL sanitizer: strips prior UTM/click IDs and adds the
    # approved Meta UTM values without changing the Shopify source URL.
    from tasks import _meta_product_url

    destination_url = _meta_product_url(product.get("product_url"))
    if not destination_url:
        return {"status": "blocked", "reason": "SHOPIFY_PRODUCT_URL_NOT_ELIGIBLE_FOR_META"}

    required_copy = ("headline", "golden_nugget", "bullets", "faq")
    if any(key not in creative for key in required_copy):
        return {"status": "blocked", "reason": "CREATIVE_COPY_INCOMPLETE"}

    if not mock_mode:
        page_is_public = (
            seo_result.get("page_published") is True
            and seo_result.get("page_http_status") == 200
            and seo_result.get("canonical_verified") is True
        )
        if not page_is_public:
            return {
                "task": "media_buyer.prepare_catalog_ad_creative",
                "status": "blocked",
                "reason": "SEO_PAGE_NOT_PUBLISHED_AND_CANONICAL_VERIFIED",
                "product_id": product_id,
                "meta_api_called": False,
                "writes_performed": False,
            }

    # This is a reviewable plan, deliberately not a Graph API request body.
    # Catalog destination URLs must come from the verified catalog/feed path;
    # this preview does not override a product URL in an ad or catalog.
    return {
        "task": "media_buyer.prepare_catalog_ad_creative",
        "status": "mock_prepared" if mock_mode else "ready_for_review",
        "mode": "mock" if mock_mode else "plan_only",
        "campaign_name": os.getenv(
            "META_CATALOG_CAMPAIGN_NAME", "Homestro All Products Catalog Ad"
        ),
        "product_id": product_id,
        "destination_url": destination_url,
        "creative": {
            "headline": creative["headline"],
            "message": creative["golden_nugget"],
            "bullets": creative["bullets"],
            "faq": creative["faq"],
            "call_to_action": creative.get("cta", "SHOP_NOW"),
        },
        "seo_page_url": seo_result.get("page_url"),
        "seo_page_published": bool(seo_result.get("page_published")),
        "meta_graph_api_called": False,
        "writes_performed": False,
        "shopify_written": False,
        "catalog_feed_written": False,
        "ad_created_or_updated": False,
    }


@app.task(
    bind=True,
    name="media_buyer.prepare_catalog_ad_creative",
    acks_late=False,
    max_retries=0,
)
def prepare_catalog_ad_creative(
    self,
    seo_result: dict[str, Any],
    mock_mode: bool = False,
) -> dict[str, Any]:
    """Validate the SEO handoff and prepare a non-writing ad review plan."""
    return _catalog_ad_plan(seo_result, mock_mode=mock_mode)


@app.task(
    bind=True,
    name="media_buyer.mock_hunter",
    acks_late=False,
    max_retries=0,
)
def mock_hunter(self) -> dict[str, Any]:
    """Return a synthetic fixture; this task never reads Shopify."""
    return {
        "product_id": "gid://shopify/Product/MOCK-SEO-001",
        "title": "Mock Produkt für den Staging-Test",
        "description": "Synthetický fixture. Nejde o skutečný produkt Homestro.",
        "handle": "mock-pilot-fixture",
        "product_url": "https://homestro.de/products/mock-pilot-fixture",
        "image_url": "",
        "price": 29.90,
        "currency": "EUR",
        "features": ["Pouze testovací data"],
        "audience": "Staging test",
    }


@app.task(
    bind=True,
    name="media_buyer.mock_creative",
    acks_late=False,
    max_retries=0,
)
def mock_creative(self, product: dict[str, Any]) -> dict[str, Any]:
    """Return synthetic copy; this task never calls OpenAI or Flux."""
    return {
        "product": product,
        "creative_result": {
            "task": "creative.generate_product_copy_and_flux_prompt",
            "status": "generated",
            "product_id": product["product_id"],
            "model": "mock",
            "creative": {
                "headline": "Mock: Mehr Freude im Alltag",
                "golden_nugget": "Syntetický testovací text bez produktových tvrzení.",
                "bullets": ["Testovací bod 1", "Testovací bod 2", "Testovací bod 3"],
                "faq": [
                    {"question": "Je to skutečný produkt?", "answer": "Ne, jde o staging fixture."},
                    {"question": "Byl kontaktován OpenAI?", "answer": "Ne, text je pevně daný mock."},
                    {"question": "Byla vytvořena fotografie?", "answer": "Ne, mock žádný obrázek negeneruje."},
                ],
                "cta": "SHOP_NOW",
                "flux_prompt": "MOCK ONLY; do not submit to an image model.",
            },
            "replicate_called": False,
            "shopify_written": False,
            "published": False,
        },
    }


@app.task(
    bind=True,
    name="media_buyer.mock_seo_page",
    acks_late=False,
    max_retries=0,
)
def mock_seo_page(self, bundle: dict[str, Any]) -> dict[str, Any]:
    """Render the real SEO HTML template against synthetic data, offline."""
    from agents.seo_geo_agent import _clean_product, _render_html, _validate_creative_result

    if not isinstance(bundle, dict):
        return {"status": "blocked", "reason": "MOCK_BUNDLE_REQUIRED", "mock": True}
    product = _clean_product(bundle.get("product"))
    creative_result = _validate_creative_result(bundle.get("creative_result"))
    page_url = f"https://seo-mock.homestro.de/p/{product['handle']}/"
    html_document = _render_html(product, creative_result, page_url)
    return {
        "task": "seo_geo.build_product_landing_page",
        "status": "mock_ready_to_publish",
        "mock": True,
        "product_id": product["product_id"],
        "product": product,
        "creative": creative_result,
        "page_url": page_url,
        "html_bytes": len(html_document.encode("utf-8")),
        "page_published": False,
        "page_http_status": None,
        "canonical_verified": False,
        "shopify_written": False,
        "search_engines_notified": False,
    }


@app.task(
    bind=True,
    name="media_buyer.run_mock_end_to_end",
    acks_late=False,
    max_retries=0,
)
def run_mock_end_to_end(self) -> dict[str, Any]:
    """Queue Hunter → Creative → SEO → Media Buyer with fixture-only tasks."""
    workflow = chain(
        mock_hunter.s(),
        mock_creative.s(),
        mock_seo_page.s(),
        prepare_catalog_ad_creative.s(mock_mode=True),
    )
    result = workflow.apply_async()
    if app.conf.task_always_eager:
        return {
            "task": "media_buyer.run_mock_end_to_end",
            "status": "completed",
            "workflow_id": result.id,
            "final_result": result.get(propagate=True),
            "shopify_api_called": False,
            "openai_api_called": False,
            "replicate_api_called": False,
            "meta_graph_api_called": False,
            "writes_performed": False,
        }
    return {
        "task": "media_buyer.run_mock_end_to_end",
        "status": "queued",
        "workflow_id": result.id,
        "sequence": [
            "media_buyer.mock_hunter",
            "media_buyer.mock_creative",
            "media_buyer.mock_seo_page",
            "media_buyer.prepare_catalog_ad_creative(mock_mode=True)",
        ],
        "shopify_api_called": False,
        "openai_api_called": False,
        "replicate_api_called": False,
        "meta_graph_api_called": False,
        "writes_performed": False,
    }
