import asyncio
import json
import os
import tempfile
import unittest

os.environ.setdefault("PILOT_ADMIN_KEY", "test-admin-key-with-at-least-32-characters")
os.environ.setdefault("PILOT_AUDIT_DB_PATH", tempfile.mktemp(suffix=".sqlite3"))

import httpx
from adtech_pilot.main_pilot import create_app


class MainPilotTests(unittest.TestCase):
    def setUp(self):
        self.db = tempfile.mktemp(suffix=".sqlite3")
        os.environ["PILOT_AD_DRY_RUN"] = "true"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "0"
        os.environ["PILOT_AUDIT_DB_PATH"] = self.db
        self.app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

    def request(self, method, path, **kwargs):
        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app), base_url="http://test"
            ) as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(run())

    def test_admin_key_required_for_feed_and_metrics(self):
        response = self.request(
            "POST",
            "/feed/validate",
            content=b"[]",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 401)

    def test_trigger_requires_exact_secret_and_does_not_accept_admin_header(self):
        self.assertEqual(self.request("POST", "/trigger").status_code, 401)
        self.assertEqual(self.request("POST", "/trigger", headers={"X-Pilot-Token": "wrong"}).status_code, 401)
        self.assertEqual(self.request("POST", "/trigger", headers={
            "X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters"}).status_code, 401)
        result = self.request("POST", "/trigger", headers={
            "X-Pilot-Token": "test-admin-key-with-at-least-32-characters"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["status"], "no_managed_campaign")

    def test_feed_validation_and_preparation_routes_do_not_publish(self):
        feed = {
            "products": [
                {
                    "id": "sku",
                    "title": "Napf",
                    "description": "Napf aus Edelstahl",
                    "link": "https://homestro.de/products/napf",
                    "image_link": "https://cdn.shopify.com/napf.jpg",
                    "price": "19.90 EUR",
                    "availability": "in_stock",
                    "brand": "Homestro",
                    "mpn": "sku",
                }
            ]
        }
        headers = {
            "X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters",
            "Content-Type": "application/json",
        }
        response = self.request(
            "POST",
            "/feed/prepare/meta",
            content=json.dumps(feed).encode(),
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "prepared_not_uploaded")
        self.assertFalse(response.json()["platform_write_performed"])

    def test_health_exposes_zero_budget_and_dry_run(self):
        response = self.request("GET", "/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["dry_run"])
        self.assertEqual(response.json()["max_budget_limit_eur"], 0)
        self.assertFalse(response.json()["mutations_enabled"])

    def test_health_reads_explicit_live_controls_and_keeps_five_euro_cap(self):
        os.environ["DRY_RUN"] = "false"
        os.environ["MARKETING_BUDGET_LIMIT"] = "1000"
        os.environ["PILOT_AD_DRY_RUN"] = "false"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "1000"
        app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.get("/healthz")

        response = asyncio.run(run())
        self.assertFalse(response.json()["dry_run"])
        self.assertEqual(response.json()["max_budget_limit_eur"], 5.0)
        # No optimizer adapter is configured, so this does not claim a mutation.
        self.assertFalse(response.json()["mutations_enabled"])

    def test_either_kill_switch_keeps_optimizer_dry(self):
        os.environ["DRY_RUN"] = "false"
        os.environ["PILOT_AD_DRY_RUN"] = "true"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "5"
        app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.get("/healthz")

        response = asyncio.run(run())
        self.assertTrue(response.json()["dry_run"])


if __name__ == "__main__":
    unittest.main()
