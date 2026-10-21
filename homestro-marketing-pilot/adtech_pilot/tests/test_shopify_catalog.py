import asyncio
import json
import unittest

import httpx

from adtech_pilot.shopify_catalog import (
    ShopifyCatalogClient,
    ShopifyCatalogConfigError,
    ShopifyCatalogError,
)


class ShopifyCatalogTests(unittest.TestCase):
    def test_products_and_nested_variants_are_fully_paginated_and_filtered(self):
        async def run():
            requests = []

            def handler(request):
                body = json.loads(request.content)
                query = body["query"]
                variables = body.get("variables", {})
                requests.append((query, variables))
                if "PilotShopCurrency" in query:
                    return httpx.Response(200, json={"data": {"shop": {"currencyCode": "EUR"}}})
                if "PilotProducts" in query and variables.get("cursor") is None:
                    return httpx.Response(
                        200,
                        json={
                            "data": {
                                "products": {
                                    "pageInfo": {"hasNextPage": True, "endCursor": "products-2"},
                                    "edges": [
                                        {
                                            "node": {
                                                "id": "gid://shopify/Product/1",
                                                "title": "Product one",
                                                "handle": "product-one",
                                                "variants": {
                                                    "pageInfo": {"hasNextPage": True, "endCursor": "variants-2"},
                                                    "edges": [
                                                        {
                                                            "node": {
                                                                "id": "gid://shopify/ProductVariant/11",
                                                                "sku": "SKU-11",
                                                                "price": "20.00",
                                                                "inventoryQuantity": 3,
                                                                "inventoryItem": {
                                                                    "unitCost": {"amount": "10.00", "currencyCode": "EUR"}
                                                                },
                                                            }
                                                        }
                                                    ],
                                                },
                                            }
                                        }
                                    ],
                                }
                            }
                        },
                    )
                if "PilotProductVariants" in query:
                    self.assertEqual(variables["productId"], "gid://shopify/Product/1")
                    self.assertEqual(variables["cursor"], "variants-2")
                    return httpx.Response(
                        200,
                        json={
                            "data": {
                                "product": {
                                    "id": "gid://shopify/Product/1",
                                    "title": "Product one",
                                    "handle": "product-one",
                                    "variants": {
                                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                                        "edges": [
                                            {
                                                "node": {
                                                    "id": "gid://shopify/ProductVariant/12",
                                                    "sku": "SKU-12",
                                                    "price": "30.00",
                                                    "inventoryQuantity": 0,
                                                    "inventoryItem": {
                                                        "unitCost": {"amount": "5.00", "currencyCode": "EUR"}
                                                    },
                                                }
                                            },
                                            {
                                                "node": {
                                                    "id": "gid://shopify/ProductVariant/13",
                                                    "sku": "SKU-13",
                                                    "price": "15.00",
                                                    "inventoryQuantity": 2,
                                                    "inventoryItem": {
                                                        "unitCost": {"amount": "13.00", "currencyCode": "EUR"}
                                                    },
                                                }
                                            },
                                        ],
                                    },
                                }
                            }
                        },
                    )
                if "PilotProducts" in query and variables.get("cursor") == "products-2":
                    return httpx.Response(
                        200,
                        json={
                            "data": {
                                "products": {
                                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                                    "edges": [
                                        {
                                            "node": {
                                                "id": "gid://shopify/Product/2",
                                                "title": "Product two",
                                                "handle": "product-two",
                                                "variants": {
                                                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                                                    "edges": [
                                                        {
                                                            "node": {
                                                                "id": "gid://shopify/ProductVariant/21",
                                                                "sku": "SKU-21",
                                                                "price": "50.00",
                                                                "inventoryQuantity": 5,
                                                                "inventoryItem": {"unitCost": None},
                                                            }
                                                        }
                                                    ],
                                                },
                                            }
                                        }
                                    ],
                                }
                            }
                        },
                    )
                return httpx.Response(500, json={"errors": [{"message": "unexpected request"}]})

            http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            client = ShopifyCatalogClient(
                "homestro.myshopify.com",
                "secret-token",
                client=http,
            )
            result = await client.fetch_margin_qualified_variants()
            await http.aclose()
            return result, requests

        result, requests = asyncio.run(run())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].sku, "SKU-11")
        self.assertEqual(result[0].inventory_quantity, 3)
        self.assertEqual(str(result[0].gross_margin_ratio), "0.5")
        self.assertEqual(sum("PilotProducts" in query for query, _ in requests), 2)
        self.assertEqual(sum("PilotProductVariants" in query for query, _ in requests), 1)

    def test_unknown_cost_wrong_currency_and_low_margin_are_excluded(self):
        client = ShopifyCatalogClient("homestro.myshopify.com", "secret-token")
        product = {
            "id": "gid://shopify/Product/1",
            "title": "Product",
            "handle": "product",
        }
        base = {
            "id": "gid://shopify/ProductVariant/1",
            "sku": "SKU",
            "price": "10.00",
            "inventoryQuantity": 4,
        }
        unknown = {**base, "inventoryItem": {"unitCost": None}}
        wrong_currency = {
            **base,
            "inventoryItem": {"unitCost": {"amount": "2.00", "currencyCode": "USD"}},
        }
        low_margin = {
            **base,
            "inventoryItem": {"unitCost": {"amount": "9.00", "currencyCode": "EUR"}},
        }
        self.assertIsNone(client._qualifying_variant(product, unknown, "EUR"))
        self.assertIsNone(client._qualifying_variant(product, wrong_currency, "EUR"))
        self.assertIsNone(client._qualifying_variant(product, low_margin, "EUR"))

    def test_rejects_custom_domain_and_missing_token(self):
        with self.assertRaises(ShopifyCatalogConfigError):
            ShopifyCatalogClient("homestro.de", "secret-token")
        with self.assertRaises(ShopifyCatalogConfigError):
            ShopifyCatalogClient("homestro.myshopify.com", "")

    def test_graphql_errors_fail_closed(self):
        async def run():
            http = httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        200,
                        json={"errors": [{"message": "ACCESS_DENIED", "extensions": None}]},
                    )
                )
            )
            client = ShopifyCatalogClient(
                "homestro.myshopify.com",
                "secret-token",
                client=http,
            )
            with self.assertRaises(ShopifyCatalogError):
                await client._graphql(http, "query { shop { currencyCode } }", {})
            await http.aclose()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
