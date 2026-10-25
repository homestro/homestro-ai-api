import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.performance_loader import load_meta_performance


class PerformanceLoaderTests(unittest.TestCase):
    def test_reads_real_values_without_double_counting_or_unlocking_scale(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                audit = PlanAuditStore(Path(directory) / "audit.sqlite")
                await audit.claim_meta_micro_campaign("act_12345", "all")
                await audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id="98765")
                def handler(request):
                    self.assertEqual(request.method, "GET")
                    self.assertEqual(request.url.params["date_preset"], "maximum")
                    self.assertEqual(request.url.path, "/v26.0/98765/insights")
                    return httpx.Response(200, json={"data": [{"campaign_id": "98765", "account_currency": "EUR",
                        "spend": "4.5", "clicks": "5", "impressions": "200", "date_start": "2026-10-20", "date_stop": "2026-10-25",
                        "actions": [{"action_type": "purchase", "value": "1"},
                                    {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "1"}],
                        "action_values": [{"action_type": "purchase", "value": "39.9"}]}]})
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                    result = await load_meta_performance(audit, env={"META_ACCESS_TOKEN": "secret"}, client=client)
                self.assertEqual(result["metrics"][0]["reported_purchases"], 1)
                self.assertEqual(result["metrics"][0]["spend_eur"], 4.5)
                self.assertFalse(result["attribution_verified"])
                self.assertIsNone(result["metrics"][0]["contribution_margin_eur"])
        asyncio.run(run())
