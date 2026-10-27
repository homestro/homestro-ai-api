import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs

import httpx
from adtech_pilot.creative_factory import (
    CreativeBrief,
    CreativeScore,
    GeneratedCreative,
)
from adtech_pilot.media_buyer import MetaPublisher, PlanAuditStore
from PIL import Image


class MetaPublisherTests(unittest.TestCase):
    def setUp(self):
        evidence_patch = patch("adtech_pilot.purchase_guard.PurchaseEvidence.check", new=AsyncMock(return_value={"verified": True}))
        evidence_patch.start()
        self.addCleanup(evidence_patch.stop)
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
            "PILOT_AD_DRY_RUN": "false",
            "PILOT_AD_MAX_BUDGET_EUR": "5.0",
            "META_ACCESS_TOKEN": "test-token",
            "META_AD_ACCOUNT_ID": "act_12345",
            "META_PIXEL_ID": "5555",
            "META_PAGE_ID": "4444",
            "META_DSA_BENEFICIARY": "Homestro legal entity",
            "META_DSA_PAYOR": "Homestro legal entity",
            "META_API_VERSION": "v26.0",
            "META_BILLING_VERIFIED": "true",
            "META_PURCHASE_EVENT_VERIFIED": "true",
            "META_PRODUCT_CATALOG_ID": "3333",
            "META_PRODUCT_SET_ID": "6666",
            "MICRO_BUDGET_PRODUCT_ID": "sku-1",
            "PILOT_CREATIVE_DIR": str(self.root),
            "PILOT_CREATIVE_MIN_SCORE": "80",
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_live_publisher_requires_both_kill_switches_and_full_daily_cap(self):
        audit = PlanAuditStore(self.root / "gate-check.sqlite3")
        publisher = MetaPublisher(audit, env=self.env)
        self.assertNotIsInstance(publisher._configuration(), dict)

        switches_only = {**self.env, "PILOT_AD_DRY_RUN": "true"}
        self.assertEqual(
            MetaPublisher(audit, env=switches_only)._configuration()["reason"],
            "DRY_RUN_ENABLED",
        )

        no_budget = {**self.env, "PILOT_AD_MAX_BUDGET_EUR": "0"}
        blocked = MetaPublisher(audit, env=no_budget)._configuration()
        self.assertEqual(blocked["reason"], "MICRO_BUDGET_DAILY_LIMIT_TOO_LOW")
        self.assertEqual(blocked["configured_daily_budget_limit_eur"], 0.0)

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
                if request.method == "GET" and path == "campaign-1":
                    return httpx.Response(200, json={"id": "campaign-1", "status": "ACTIVE"})
                if request.method == "GET" and path == "campaigns":
                    return httpx.Response(200, json={"data": []})
                if request.method == "GET" and path == "adsets":
                    return httpx.Response(200, json={"data": []})
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
        self.assertEqual(result["daily_budget_eur"], 5.0)
        self.assertEqual(result["lifetime_budget_eur"], 0.0)
        self.assertEqual(result["planned_total_eur"], 35.0)
        self.assertEqual(result["budget_type"], "daily")
        self.assertEqual(repeat["reason"], "EXISTING_CAMPAIGN_RETAINED_NO_DUPLICATE")
        self.assertEqual(
            sum(event[0] == "POST" and event[1] == "campaigns" for event in events),
            1,
        )
        self.assertEqual(sum(event[0] == "POST" and event[1] == "ads" for event in events), 1)
        created_forms = [
            (event, parse_qs(event[2]))
            for event in events
            if event[0] == "POST" and event[1] in {"campaigns", "adsets", "ads"}
        ]
        self.assertTrue(all(form.get("status") == ["PAUSED"] for _, form in created_forms))
        adset_form = next(form for event, form in created_forms if event[1] == "adsets")
        self.assertEqual(adset_form["daily_budget"], ["500"])
        self.assertIn('"custom_event_type": "PURCHASE"', adset_form["promoted_object"][0])


    def test_product_set_resolution_fails_closed_on_duplicate_all_products_names(self):
        async def run():
            def handler(request):
                if request.method == "GET" and request.url.path.endswith("/3333/product_sets"):
                    return httpx.Response(
                        200,
                        json={
                            "data": [
                                {"id": "1111", "name": "All Products"},
                                {"id": "2222", "name": "All Products"},
                            ]
                        },
                    )
                return httpx.Response(404, json={"error": {"message": "unexpected test request"}})

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            publisher = MetaPublisher(
                PlanAuditStore(self.root / "ambiguous-set.sqlite3"),
                client=client,
                env={},
            )
            result = await publisher._resolve_all_products_set(client, "3333", {})
            await client.aclose()
            return result

        self.assertIsNone(asyncio.run(run()))

    def test_website_carousel_uses_purchase_optimization_without_any_catalog_request(self):
        async def run():
            events = []
            def handler(request):
                tail = request.url.path.rsplit("/", 1)[-1]
                events.append((request.method, request.url.path, parse_qs(request.content.decode())))
                if request.method == "GET":
                    if tail == "act_12345":
                        return httpx.Response(200, json={"id": "act_12345", "account_status": 1, "currency": "EUR"})
                    if tail == "adspixels":
                        return httpx.Response(200, json={"data": [{"id": "5555", "is_unavailable": False}]})
                    if tail == "4444":
                        return httpx.Response(200, json={"id": "4444", "name": "Homestro"})
                    if tail == "adsets":
                        return httpx.Response(200, json={"data": []})
                if request.method == "POST" and tail in {"campaigns", "adsets", "adcreatives", "ads"}:
                    return httpx.Response(200, json={"id": {"campaigns": "90001", "adsets": "90002", "adcreatives": "90003", "ads": "90004"}[tail]})
                if request.method == "POST" and tail in {"90001", "90002", "90004"}:
                    return httpx.Response(200, json={"success": True})
                self.fail("Unexpected network request " + str(request.url))
            env = {**self.env, "PILOT_AD_MODE": "website_sales"}
            env.pop("META_PRODUCT_CATALOG_ID")
            env.pop("META_PRODUCT_SET_ID")
            products = [{**self.product, "title": "Küchenhelfer", "price": "39.90", "availability": "in_stock",
                         "image_link": "https://cdn.shopify.com/product.jpg"},
                        {"id": "sku-2", "link": "https://homestro.de/products/zweites-produkt", "title": "Organizer",
                         "price": "34.90", "availability": "in_stock", "image_link": "https://cdn.shopify.com/product2.jpg"}]
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                publisher = MetaPublisher(PlanAuditStore(self.root / "website.sqlite"), client=client, env=env)
                result = await publisher.publish_one(creative=None, product=products[0], products=products,
                    product_ids_in_feed={"sku-1", "sku-2"})
                repeated = await publisher.publish_one(creative=None, product=products[0], products=products,
                    product_ids_in_feed={"sku-1", "sku-2"})
            self.assertEqual(result["status"], "ACTIVE_PENDING_REVIEW")
            self.assertEqual(result["advertised_product_ids"], ["sku-1", "sku-2"])
            self.assertEqual(repeated["status"], "existing_campaign")
            self.assertFalse(any("catalog" in path or "product_sets" in path for _, path, _ in events))
            forms = {path.rsplit("/", 1)[-1]: form for method, path, form in events
                     if method == "POST" and path.rsplit("/", 1)[-1] in {"adsets", "adcreatives"}}
            promoted = __import__("json").loads(forms["adsets"]["promoted_object"][0])
            self.assertEqual(promoted, {"pixel_id": "5555", "custom_event_type": "PURCHASE"})
            story = __import__("json").loads(forms["adcreatives"]["object_story_spec"][0])
            self.assertEqual(len(story["link_data"]["child_attachments"]), 2)
            self.assertNotIn("template_data", story)
        asyncio.run(run())

    def test_paused_prior_campaign_keeps_identity_without_creating_duplicate(self):
        async def run():
            events = []

            def handler(request):
                path = request.url.path
                tail = path.rstrip("/").rsplit("/", 1)[-1]
                events.append((request.method, path))
                if request.method == "GET" and tail == "act_12345":
                    return httpx.Response(200, json={"id": "act_12345", "account_status": 1, "currency": "EUR"})
                if request.method == "GET" and tail == "adspixels":
                    return httpx.Response(200, json={"data": [{"id": "5555", "is_unavailable": False}]})
                if request.method == "GET" and tail == "4444":
                    return httpx.Response(200, json={"id": "4444", "name": "Homestro"})
                if request.method == "GET" and tail == "old-campaign":
                    return httpx.Response(200, json={"id": "old-campaign", "status": "PAUSED"})
                if request.method == "GET" and tail == "adsets" and "old-campaign" in path:
                    return httpx.Response(200, json={"data": [{"id": "old-adset", "status": "PAUSED"}]})
                if request.method == "GET" and tail == "adsets":
                    return httpx.Response(200, json={"data": []})
                ids = {"campaigns": "campaign-new", "adsets": "adset-new", "adcreatives": "creative-new", "ads": "ad-new"}
                if request.method == "POST" and tail in ids:
                    return httpx.Response(200, json={"id": ids[tail]})
                if request.method == "POST" and tail in {"campaign-new", "adset-new", "ad-new"}:
                    return httpx.Response(200, json={"success": True})
                return httpx.Response(404, json={"error": {"message": "unexpected test request"}})

            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            audit = PlanAuditStore(self.root / "audit-paused-campaign.sqlite3")
            await audit.claim_meta_micro_campaign("act_12345", "old-product")
            await audit.update_meta_micro_campaign(
                status="ACTIVE_PENDING_REVIEW", campaign_id="old-campaign"
            )
            publisher = MetaPublisher(audit, client=client, env=self.env)
            result = await publisher.publish_one(
                creative=None,
                product=self.product,
                product_ids_in_feed={"sku-1"},
            )
            claim = await audit.get_meta_micro_campaign_claim()
            await client.aclose()
            return result, claim, events

        result, claim, events = asyncio.run(run())
        self.assertEqual(result["status"], "existing_campaign")
        self.assertEqual(claim["campaign_id"], "old-campaign")
        self.assertFalse(any(method == "POST" for method, _ in events))

    def test_retirement_works_without_purchase_but_never_releases_active_campaign(self):
        async def run(remote_status):
            campaign_id = "120254321479480274"
            def handler(request):
                self.assertEqual(request.method, "GET")
                if request.url.path.endswith("/adsets"):
                    return httpx.Response(200, json={"data": []})
                return httpx.Response(200, json={"id": campaign_id, "status": remote_status})
            audit = PlanAuditStore(self.root / f"retire-{remote_status}.sqlite3")
            await audit.claim_meta_micro_campaign("act_12345", "old-product")
            await audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id=campaign_id)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                publisher = MetaPublisher(audit, client=client, env={"META_ACCESS_TOKEN": "test-token"})
                result = await publisher.reconcile_retired_campaign()
            with audit._connect() as connection:
                archived = connection.execute("SELECT payload_json FROM adtech_audit WHERE kind='meta_campaign_archived'").fetchall()
            return result, await audit.get_meta_micro_campaign_claim(), archived
        result, claim, archived = asyncio.run(run("PAUSED"))
        self.assertEqual(result["status"], "INACTIVE")
        self.assertIsNone(claim)
        self.assertEqual(len(archived), 1)
        result, claim, archived = asyncio.run(run("ACTIVE"))
        self.assertEqual(result["status"], "blocked")
        self.assertIsNotNone(claim)
        self.assertEqual(archived, [])

    def test_retirement_pauses_only_children_and_confirms_before_archiving(self):
        async def run():
            campaign_id = "120254321479480274"
            paused = False
            def handler(request):
                nonlocal paused
                if request.method == "POST":
                    self.assertTrue(request.url.path.endswith("/987654321"))
                    self.assertEqual(parse_qs(request.content.decode()), {"status": ["PAUSED"]})
                    paused = True
                    return httpx.Response(200, json={"success": True})
                if request.url.path.endswith("/adsets"):
                    return httpx.Response(200, json={"data": [{"id": "987654321", "status": "PAUSED" if paused else "ACTIVE"}]})
                return httpx.Response(200, json={"id": campaign_id, "status": "PAUSED"})
            audit = PlanAuditStore(self.root / "retire-children.sqlite3")
            await audit.claim_meta_micro_campaign("act_12345", "old-product")
            await audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id=campaign_id)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await MetaPublisher(audit, client=client, env={"META_ACCESS_TOKEN": "test-token"}).reconcile_retired_campaign()
            self.assertTrue(paused)
            self.assertEqual(result["status"], "INACTIVE")
            self.assertIsNone(await audit.get_meta_micro_campaign_claim())
        asyncio.run(run())

if __name__ == "__main__":
    unittest.main()
