from datetime import date
import unittest

import httpx

from adtech_pilot.media_buyer import Platform
from adtech_pilot.meta_insights import MetaInsightsClient


class MetaInsightsTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_campaign_metrics_without_marking_attribution_verified(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "campaign_id": "12345",
                            "campaign_name": "Homestro DE",
                            "spend": "12.34",
                            "impressions": "1000",
                            "clicks": "25",
                            "actions": [
                                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "2"}
                            ],
                            "action_values": [
                                {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "79.80"}
                            ],
                        }
                    ]
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await MetaInsightsClient(
                "never-print-this", "act_12345", client=client
            ).campaign_metrics(days=7, until=date(2026, 10, 23))

        metric = result[0]
        self.assertEqual(metric.platform, Platform.META)
        self.assertEqual(metric.campaign_id, "12345")
        self.assertEqual(metric.spend_eur, 12.34)
        self.assertEqual(metric.revenue_eur, 79.8)
        self.assertEqual(metric.conversions, 2)
        self.assertEqual(metric.daily_budget_eur, 0)
        self.assertIsNone(metric.contribution_margin_eur)
        self.assertFalse(metric.attribution_verified)
        self.assertEqual(requests[0].method, "GET")
        self.assertTrue(requests[0].url.path.endswith("/act_12345/insights"))
        self.assertEqual(requests[0].url.params.get("level"), "campaign")
        time_range = requests[0].url.params.get("time_range")
        self.assertIn("2026-10-17", time_range)
        self.assertIn("2026-10-23", time_range)

    async def test_prefers_pixel_purchase_action_without_double_counting_omni_purchase(self):
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "campaign_id": "12345",
                                "actions": [
                                    {"action_type": "omni_purchase", "value": "9"},
                                    {
                                        "action_type": "offsite_conversion.fb_pixel_purchase",
                                        "value": "2",
                                    },
                                ],
                                "action_values": [
                                    {"action_type": "omni_purchase", "value": "500"},
                                    {
                                        "action_type": "offsite_conversion.fb_pixel_purchase",
                                        "value": "80",
                                    },
                                ],
                            }
                        ]
                    },
                )
            )
        ) as client:
            metric = (
                await MetaInsightsClient("token", "act_12345", client=client).campaign_metrics()
            )[0]

        self.assertEqual(metric.conversions, 2)
        self.assertEqual(metric.revenue_eur, 80)

    async def test_rejects_invalid_request_values(self):
        with self.assertRaises(ValueError):
            MetaInsightsClient("token", "12345")
        with self.assertRaises(ValueError):
            MetaInsightsClient("token", "act_12345", api_version="latest")
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": []}))
        ) as client:
            with self.assertRaises(ValueError):
                await MetaInsightsClient("token", "act_12345", client=client).campaign_metrics(days=31)


if __name__ == "__main__":
    unittest.main()
