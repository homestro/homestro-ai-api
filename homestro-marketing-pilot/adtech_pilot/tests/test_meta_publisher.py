import asyncio
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

import httpx
from PIL import Image

from adtech_pilot.creative_factory import (
    CreativeBrief,
    CreativeScore,
    GeneratedCreative,
)
from adtech_pilot.media_buyer import MetaPublisher, PlanAuditStore


class MetaPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image_path = self.root / "approved.png"
        image = Image.new("RGB", (320, 320), (40, 120, 80))
        image.save(self.image_path, format="PNG")
        self.creative = GeneratedCreative(
            brief=CreativeBrief(
                product_id="sku-1",
                platform="meta",
                hook="Mehr Freude beim Spielen",
                problem="Langeweile im Alltag",
                solution="Ein Spielzeug für gemeinsame Momente",
                headline="Spielspaß für deinen Hund",
                primary_text="Entdecke ein neues Spielzeug für gemeinsame Spielmomente.",
                description="Jetzt bei Homestro entdecken",
                call_to_action="Shop Now",
                visual_prompt="A dog playing with a toy in a sunny garden",
                factual_claims=["Hundespielzeug"],
            ),
            score=CreativeScore(
                quality_score=80,
                product_faithful=True,
                logo_visible=True,
                lifestyle_background=True,
                factual_claims_supported=True,
                rationale=["Passes verified creative checks"],
            ),
            asset_path=str(self.image_path),
            publishable_candidate=True,
        )
        self.product = {
            "id": "sku-1",
            "link": "https://homestro.de/products/test-product",
        }
        self.env = {
            "ALLOW_MICRO_BUDGET": "true",
            "DRY_RUN": "false",
            "META_ACCESS_TOKEN": "test-token",
            "META_AD_ACCOUNT_ID": "act_12345",
            "META_PIXEL_ID": "5555",
            "META_PAGE_ID": "4444",
            "META_DSA_BENEFICIARY": "Homestro legal entity",
            "META_DSA_PAYOR": "Homestro legal entity",
            "META_API_VERSION": "v26.0",
            "META_BILLING_VERIFIED": "true",
            "MICRO_BUDGET_PRODUCT_ID": "sku-1",
            "PILOT_CREATIVE_DIR": str(self.root),
            "PILOT_CREATIVE_MIN_SCORE": "80",
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_defaults_block_without_any_meta_api_request(self):
        async def run():
            requests = []

            def handler(request):
                requests.append(request.method)
                return httpx.Response(500)

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            publisher = MetaPublisher(
                PlanAuditStore(self.root / "audit.sqlite3"),
                client=client,
                env={"ALLOW_MICRO_BUDGET": "false", "DRY_RUN": "true"},
            )
            result = await publisher.publish_one(
                creative=self.creative,
                product=self.product,
                product_ids_in_feed={"sku-1"},
            )
            await client.aclose()
            return result, requests

        result, requests = asyncio.run(run())
        self.assertEqual(result["reason"], "MICRO_BUDGET_NOT_ENABLED")
        self.assertEqual(requests, [])

    def test_scheduled_readiness_checks_meta_account_page_pixel_without_writes(self):
        async def run():
            requests = []

            def handler(request):
                requests.append((request.method, request.url.path))
                path = request.url.path.rsplit("/", 1)[-1]
                if path == "act_12345":
                    return httpx.Response(
                        200,
                        json={
                            "id": "act_12345",
                            "account_status": 1,
                            "currency": "EUR",
                        },
                    )
                if path == "adspixels":
                    return httpx.Response(
                        200,
                        json={"data": [{"id": "5555", "is_unavailable": False}]},
                    )
                if path == "4444":
                    return httpx.Response(200, json={"id": "4444", "name": "Homestro"})
                return httpx.Response(404, json={"error": {"message": "secret body"}})

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            publisher = MetaPublisher(
                PlanAuditStore(self.root / "readiness.sqlite3"),
                client=client,
                env={
                    "META_ACCESS_TOKEN": "do-not-return-this-token",
                    "META_AD_ACCOUNT_ID": "act_12345",
                    "META_PIXEL_ID": "5555",
                    "META_PAGE_ID": "4444",
                    "META_BILLING_VERIFIED": "false",
                },
            )
            result = await publisher.check_readiness()
            await client.aclose()
            return result, requests

        result, requests = asyncio.run(run())
        self.assertEqual(result["status"], "checked")
        self.assertEqual(result["account"]["account_status"], "active")
        self.assertEqual(result["account"]["currency"], "EUR")
        self.assertFalse(result["account"]["billing_ready"])
        self.assertTrue(result["account"]["pixel_access_verified"])
        self.assertTrue(all(method == "GET" for method, _ in requests))
        self.assertNotIn("do-not-return-this-token", str(result))

    def test_scheduled_readiness_fails_closed_without_echoing_provider_body(self):
        async def run():
            requests = []

            def handler(request):
                requests.append(request.method)
                return httpx.Response(
                    400,
                    json={
                        "error": {
                            "message": "secret body",
                            "type": "OAuthException",
                            "code": 200,
                            "error_subcode": 10,
                        }
                    },
                )

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            publisher = MetaPublisher(
                PlanAuditStore(self.root / "readiness-failed.sqlite3"),
                client=client,
                env={
                    "META_ACCESS_TOKEN": "do-not-return-this-token",
                    "META_AD_ACCOUNT_ID": "act_12345",
                    "META_PIXEL_ID": "5555",
                    "META_PAGE_ID": "4444",
                },
            )
            result = await publisher.check_readiness()
            await client.aclose()
            return result, requests

        result, requests = asyncio.run(run())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_type"], "MetaHTTPError")
        self.assertEqual(result["http_status"], 400)
        self.assertEqual(result["stage"], "account")
        self.assertEqual(result["meta_error_code"], 200)
        self.assertEqual(result["meta_error_subcode"], 10)
        self.assertEqual(result["meta_error_type"], "OAuthException")
        self.assertEqual(requests, ["GET"])
        self.assertNotIn("secret body", str(result))
        self.assertNotIn("do-not-return-this-token", str(result))

    def test_publisher_preflights_creates_paused_objects_then_activates_one_capped_test(self):
        async def run():
            events = []

            def handler(request):
                path = request.url.path.rsplit("/", 1)[-1]
                events.append((request.method, path, request.content.decode("latin1")))
                if request.method == "GET" and path == "act_12345":
                    return httpx.Response(200, json={"id": "act_12345", "account_status": 1, "currency": "EUR"})
                if request.method == "GET" and path == "adspixels":
                    return httpx.Response(200, json={"data": [{"id": "5555", "is_unavailable": False}]})
                if request.method == "GET" and path == "4444":
                    return httpx.Response(200, json={"id": "4444", "name": "Homestro"})
                if path == "adimages":
                    return httpx.Response(200, json={"images": {"approved.png": {"hash": "imagehash"}}})
                ids = {"campaigns": "campaign-1", "adsets": "adset-1", "adcreatives": "creative-1", "ads": "ad-1"}
                if path in ids:
                    return httpx.Response(200, json={"id": ids[path]})
                if request.method == "POST" and path in {"campaign-1", "adset-1", "ad-1"}:
                    return httpx.Response(200, json={"success": True})
                return httpx.Response(400, json={"error": {"code": 999}})

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            audit = PlanAuditStore(self.root / "audit-live.sqlite3")
            publisher = MetaPublisher(audit, client=client, env=self.env)
            result = await publisher.publish_one(
                creative=self.creative,
                product=self.product,
                product_ids_in_feed={"sku-1"},
            )
            repeat = await publisher.publish_one(
                creative=self.creative,
                product=self.product,
                product_ids_in_feed={"sku-1"},
            )
            await client.aclose()
            return result, repeat, events

        result, repeat, events = asyncio.run(run())
        self.assertEqual(result["status"], "ACTIVE_PENDING_REVIEW")
        self.assertEqual(result["daily_budget_eur"], 0.0)
        self.assertEqual(result["lifetime_budget_eur"], 5.0)
        self.assertEqual(result["planned_total_eur"], 5.0)
        self.assertEqual(result["budget_type"], "lifetime")
        self.assertEqual(repeat["reason"], "ONE_CAMPAIGN_ALLOWANCE_ALREADY_CLAIMED")
        self.assertEqual(sum(event[1] == "campaigns" for event in events), 1)
        self.assertEqual(sum(event[1] == "ads" for event in events), 1)
        created_forms = [
            (event, parse_qs(event[2]))
            for event in events
            if event[1] in {"campaigns", "adsets", "ads"}
        ]
        self.assertTrue(all(form.get("status") == ["PAUSED"] for _, form in created_forms))
        adset_form = next(form for event, form in created_forms if event[1] == "adsets")
        self.assertEqual(adset_form["lifetime_budget"], ["500"])
        self.assertIn('"custom_event_type": "ADD_TO_CART"', adset_form["promoted_object"][0])


if __name__ == "__main__":
    unittest.main()
