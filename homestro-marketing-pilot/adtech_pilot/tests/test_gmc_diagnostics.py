import asyncio
import unittest

import httpx

from adtech_pilot.gmc_diagnostics import MerchantDiagnosticsClient


class MerchantDiagnosticsTests(unittest.TestCase):
    def test_reads_account_and_product_diagnostics_without_mutating(self):
        requests = []

        def handler(request):
            requests.append(request.method)
            if request.url.path.endswith("/issues"):
                return httpx.Response(
                    200,
                    json={
                        "accountIssues": [
                            {
                                "title": "Shipping settings incomplete",
                                "severity": "CRITICAL",
                                "detail": "Configure shipping service",
                            }
                        ]
                    },
                )
            return httpx.Response(
                200,
                json={
                    "products": [
                        {
                            "productStatus": {
                                "destinationStatuses": [{"status": "disapproved"}],
                                "itemLevelIssues": [
                                    {"code": "missing_gtin", "severity": "ERROR"}
                                ],
                            }
                        },
                        {"productStatus": {"destinationStatuses": [{"status": "approved"}]}},
                    ]
                },
            )

        async def run():
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            diagnostics = MerchantDiagnosticsClient(
                "123456", access_token_provider=lambda: "test-token", client=client
            )
            report = await diagnostics.diagnose()
            await client.aclose()
            return report

        report = asyncio.run(run())
        self.assertEqual(report["products_checked"], 2)
        self.assertEqual(report["disapproved_products"], 1)
        self.assertEqual(report["item_issue_counts_by_code"], {"missing_gtin": 1})
        self.assertFalse(report["mutations_performed"])
        self.assertEqual(requests, ["GET", "GET"])

    def test_requires_numeric_account_and_configured_credentials(self):
        with self.assertRaises(ValueError):
            MerchantDiagnosticsClient("not-a-number", access_token_provider=lambda: "x")
        with self.assertRaises(ValueError):
            MerchantDiagnosticsClient("123456", credentials_json="")


if __name__ == "__main__":
    unittest.main()
