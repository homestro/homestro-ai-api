"""Read-only Shopify Admin GraphQL catalog reader with complete cursor pagination.

This module validates gross product margin and sellable stock. It does not infer
Meta catalog retailer IDs, create product sets, or write to an advertising account.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


class ShopifyCatalogError(RuntimeError):
    """The Shopify catalog could not be read completely and safely."""


class ShopifyCatalogConfigError(ShopifyCatalogError):
    """Required Shopify API configuration is missing or invalid."""


class ShopifyVariantMargin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str = Field(min_length=1)
    product_title: str = Field(min_length=1)
    product_handle: str = Field(min_length=1)
    variant_id: str = Field(min_length=1)
    sku: str | None = None
    inventory_quantity: int = Field(ge=0)
    price: Decimal = Field(gt=0)
    unit_cost: Decimal = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    gross_margin_ratio: Decimal


PRODUCTS_QUERY = """
query PilotProducts($cursor: String) {
  products(first: 10, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        handle
        variants(first: 10) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              sku
              price
              inventoryQuantity
              inventoryItem {
                unitCost { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
}
"""

PRODUCT_VARIANTS_QUERY = """
query PilotProductVariants($productId: ID!, $cursor: String) {
  product(id: $productId) {
    id
    title
    handle
    variants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          price
          inventoryQuantity
          inventoryItem {
            unitCost { amount currencyCode }
          }
        }
      }
    }
  }
}
"""

SHOP_CURRENCY_QUERY = """
query PilotShopCurrency {
  shop { currencyCode }
}
"""


class ShopifyCatalogClient:
    """Fetch every active product and variant, failing closed on incomplete pages."""

    API_VERSION_RE = re.compile(r"^20\d{2}-(01|04|07|10)$")
    DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.myshopify\.com$", re.IGNORECASE)
    PRODUCTS_PER_PAGE = 10
    VARIANTS_PER_PAGE = 100
    MINIMUM_GROSS_MARGIN = Decimal("0.20")
    MAX_PRODUCTS = 50_000
    MAX_VARIANTS = 250_000
    MAX_RETRIES = 3

    def __init__(
        self,
        shop_domain: str,
        access_token: str,
        *,
        api_version: str = "2026-10",
        client: httpx.AsyncClient | None = None,
    ):
        domain = (shop_domain or "").strip().lower()
        domain = re.sub(r"^https?://", "", domain)
        domain = domain.split("/", 1)[0]
        if not self.DOMAIN_RE.fullmatch(domain):
            raise ShopifyCatalogConfigError(
                "SHOPIFY_STORE_URL must be the shop's *.myshopify.com API domain"
            )
        if not access_token or not access_token.strip():
            raise ShopifyCatalogConfigError("SHOPIFY_ACCESS_TOKEN is missing")
        if not self.API_VERSION_RE.fullmatch(api_version):
            raise ShopifyCatalogConfigError("SHOPIFY_API_VERSION is invalid")
        self.url = f"https://{domain}/admin/api/{api_version}/graphql.json"
        self.access_token = access_token.strip()
        self.client = client

    async def fetch_margin_qualified_variants(self) -> list[ShopifyVariantMargin]:
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        try:
            currency_data = await self._graphql(client, SHOP_CURRENCY_QUERY, {})
            shop = currency_data.get("shop")
            currency = str(shop.get("currencyCode", "")).upper() if isinstance(shop, dict) else ""
            if not re.fullmatch(r"[A-Z]{3}", currency):
                raise ShopifyCatalogError("Shopify did not return a valid shop currency")

            accepted: list[ShopifyVariantMargin] = []
            product_cursor: str | None = None
            product_count = 0
            variant_count = 0
            seen_product_cursors: set[str] = set()

            while True:
                payload = await self._graphql(
                    client, PRODUCTS_QUERY, {"cursor": product_cursor}
                )
                connection = payload.get("products")
                if not isinstance(connection, dict) or not isinstance(connection.get("edges"), list):
                    raise ShopifyCatalogError("Shopify product page is incomplete")

                for edge in connection["edges"]:
                    node = edge.get("node") if isinstance(edge, dict) else None
                    if not isinstance(node, dict):
                        raise ShopifyCatalogError("Shopify product node is incomplete")
                    product_count += 1
                    if product_count > self.MAX_PRODUCTS:
                        raise ShopifyCatalogError("Catalog exceeded the configured product safety limit")

                    variants = node.get("variants")
                    if not isinstance(variants, dict) or not isinstance(variants.get("edges"), list):
                        raise ShopifyCatalogError("Shopify variant page is incomplete")
                    variant_edges = list(variants["edges"])

                    # Product connections can contain more than the nested first page.
                    variant_page = variants
                    seen_variant_cursors: set[str] = set()
                    while bool((variant_page.get("pageInfo") or {}).get("hasNextPage")):
                        next_cursor = (variant_page.get("pageInfo") or {}).get("endCursor")
                        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_variant_cursors:
                            raise ShopifyCatalogError("Shopify variant pagination cursor is invalid")
                        seen_variant_cursors.add(next_cursor)
                        more = await self._graphql(
                            client,
                            PRODUCT_VARIANTS_QUERY,
                            {"productId": str(node["id"]), "cursor": next_cursor},
                        )
                        product = more.get("product")
                        if not isinstance(product, dict) or str(product.get("id")) != str(node["id"]):
                            raise ShopifyCatalogError("Shopify returned a mismatched product during variant pagination")
                        variant_page = product.get("variants")
                        if not isinstance(variant_page, dict) or not isinstance(variant_page.get("edges"), list):
                            raise ShopifyCatalogError("Shopify variant continuation page is incomplete")
                        variant_edges.extend(variant_page["edges"])

                    for variant_edge in variant_edges:
                        variant = variant_edge.get("node") if isinstance(variant_edge, dict) else None
                        if not isinstance(variant, dict):
                            raise ShopifyCatalogError("Shopify variant node is incomplete")
                        variant_count += 1
                        if variant_count > self.MAX_VARIANTS:
                            raise ShopifyCatalogError("Catalog exceeded the configured variant safety limit")
                        parsed = self._qualifying_variant(node, variant, currency)
                        if parsed is not None:
                            accepted.append(parsed)

                page_info = connection.get("pageInfo")
                if not isinstance(page_info, dict):
                    raise ShopifyCatalogError("Shopify product pageInfo is missing")
                if not page_info.get("hasNextPage"):
                    break
                next_cursor = page_info.get("endCursor")
                if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_product_cursors:
                    raise ShopifyCatalogError("Shopify product pagination cursor is invalid")
                seen_product_cursors.add(next_cursor)
                product_cursor = next_cursor

            logger.info(
                "Shopify catalog read complete: products=%d variants=%d margin_and_stock_qualified=%d",
                product_count,
                variant_count,
                len(accepted),
            )
            return accepted
        finally:
            if own_client:
                await client.aclose()

    def _qualifying_variant(
        self, product: dict[str, Any], variant: dict[str, Any], shop_currency: str
    ) -> ShopifyVariantMargin | None:
        quantity = variant.get("inventoryQuantity")
        if not isinstance(quantity, int) or quantity <= 0:
            return None

        item = variant.get("inventoryItem")
        cost = item.get("unitCost") if isinstance(item, dict) else None
        if not isinstance(cost, dict) or cost.get("amount") is None:
            return None
        if str(cost.get("currencyCode", "")).upper() != shop_currency:
            return None

        try:
            price = Decimal(str(variant.get("price")))
            unit_cost = Decimal(str(cost["amount"]))
        except (InvalidOperation, TypeError, ValueError):
            return None
        if not price.is_finite() or not unit_cost.is_finite() or price <= 0 or unit_cost < 0:
            return None
        margin = (price - unit_cost) / price
        if margin < self.MINIMUM_GROSS_MARGIN:
            return None

        product_id = product.get("id")
        variant_id = variant.get("id")
        title = product.get("title")
        handle = product.get("handle")
        if not all(isinstance(value, str) and value for value in (product_id, variant_id, title, handle)):
            return None

        sku_value = variant.get("sku")
        sku = sku_value.strip() if isinstance(sku_value, str) and sku_value.strip() else None
        return ShopifyVariantMargin(
            product_id=product_id,
            product_title=title,
            product_handle=handle,
            variant_id=variant_id,
            sku=sku,
            inventory_quantity=quantity,
            price=price,
            unit_cost=unit_cost,
            currency=shop_currency,
            gross_margin_ratio=margin,
        )

    async def _graphql(
        self, client: httpx.AsyncClient, query: str, variables: dict[str, Any]
    ) -> dict[str, Any]:
        headers = {
            "X-Shopify-Access-Token": self.access_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        for attempt in range(self.MAX_RETRIES + 1):
            response = await client.post(
                self.url, json={"query": query, "variables": variables}, headers=headers
            )
            if response.status_code == 429 and attempt < self.MAX_RETRIES:
                retry_after = response.headers.get("Retry-After", "")
                try:
                    delay = min(10.0, max(0.25, float(retry_after)))
                except ValueError:
                    delay = min(8.0, 0.5 * (2 ** attempt))
                await asyncio.sleep(delay)
                continue
            try:
                response.raise_for_status()
                body = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise ShopifyCatalogError(
                    f"Shopify GraphQL transport failed (HTTP {response.status_code})"
                ) from exc
            if not isinstance(body, dict):
                raise ShopifyCatalogError("Shopify GraphQL response was malformed")
            errors = body.get("errors")
            if errors:
                throttled = any(
                    isinstance(error, dict)
                    and (
                        "THROTTL" in str(error.get("extensions", {}).get("code", "")).upper()
                        or "THROTTL" in str(error.get("message", "")).upper()
                    )
                    for error in errors
                )
                if throttled and attempt < self.MAX_RETRIES:
                    await asyncio.sleep(min(8.0, 0.5 * (2 ** attempt)))
                    continue
                raise ShopifyCatalogError("Shopify GraphQL returned errors; catalog is not trusted")
            data = body.get("data")
            if not isinstance(data, dict):
                raise ShopifyCatalogError("Shopify GraphQL response has no data")
            return data
        raise ShopifyCatalogError("Shopify GraphQL retry limit exceeded")
