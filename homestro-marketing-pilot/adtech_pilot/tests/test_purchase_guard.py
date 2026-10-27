import asyncio
import copy
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from adtech_pilot.media_buyer import MetaPublisher, PlanAuditStore
from adtech_pilot.purchase_guard import (
    PurchaseEvidence,
    PurchaseWatchdog,
    paid_in_window,
)


class PurchaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(UTC)
        self.order = {"id": "private-order-id", "test": False, "cancelledAt": None,
            "displayFinancialStatus": "PAID", "shippingAddress": {"countryCodeV2": "DE"},
            "transactions": [{"kind": "SALE", "status": "SUCCESS", "test": False, "processedAt": self.now.isoformat(),
                              "amountSet": {"shopMoney": {"amount": "39.90", "currencyCode": "EUR"}}}]}

    def test_real_payment_required_and_rejects_wrong_country_refund_test_and_old(self):
        self.assertTrue(paid_in_window(self.order, self.now))
        for key, value in [("test", True), ("cancelledAt", self.now.isoformat()),
                           ("displayFinancialStatus", "REFUNDED"), ("shippingAddress", {"countryCodeV2": "US"})]:
            with self.subTest(key=key):
                self.assertFalse(paid_in_window({**self.order, key: value}, self.now))
        for key, value in [("kind", "AUTHORIZATION"), ("status", "FAILURE"), ("test", True),
                           ("processedAt", (self.now - timedelta(minutes=16)).isoformat()),
                           ("processedAt", (self.now + timedelta(minutes=1)).isoformat())]:
            row = copy.deepcopy(self.order)
            row["transactions"][0][key] = value
            self.assertFalse(paid_in_window(row, self.now))

    def test_orders_paginated_no_customer_data_or_tokens_in_evidence(self):
        async def run():
            requests = []
            def handler(request):
                requests.append(request)
                return httpx.Response(200, json={"data": {"orders": {"nodes": [self.order],
                    "pageInfo": {"hasNextPage": len(requests) == 1, "endCursor": "next"}}}})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await PurchaseEvidence(env={"SHOPIFY_STORE_DOMAIN": "homestro.myshopify.com",
                    "SHOPIFY_ACCESS_TOKEN": "secret-token"}, client=client).check(now=self.now)
            self.assertTrue(result["verified"])
            self.assertEqual(result["qualifying_orders"], 1)
            self.assertEqual(len(requests), 2)
            self.assertNotIn("private-order-id", str(result))
            self.assertNotIn("secret-token", str(result))
        asyncio.run(run())

    def test_incomplete_query_or_provider_error_never_unlocks(self):
        async def run():
            for body in [{"errors": [{"message": "private error"}]},
                         {"data": {"orders": {"nodes": [self.order], "pageInfo": {"hasNextPage": True, "endCursor": None}}}}]:
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
                    result = await PurchaseEvidence(env={"SHOPIFY_STORE_DOMAIN": "homestro.myshopify.com",
                        "SHOPIFY_ACCESS_TOKEN": "secret"}, client=client).check(now=self.now)
                self.assertFalse(result["verified"])
                self.assertNotIn("private error", str(result))
        asyncio.run(run())

    def test_missing_purchase_pauses_exact_managed_campaign_even_in_dry_run_and_preserves_claim(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                audit = PlanAuditStore(Path(directory) / "audit.sqlite")
                await audit.claim_meta_micro_campaign("act_12345", "all")
                await audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id="98765")
                requests = []
                def handler(request):
                    requests.append(request)
                    self.assertEqual(request.url.path, "/v26.0/98765")
                    return httpx.Response(200, json={"success": True} if request.method == "POST" else {"id": "98765", "status": "PAUSED"})
                evidence = AsyncMock()
                evidence.check.return_value = {"verified": False, "reason": "PROVIDER_DOWN"}
                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                    guard = PurchaseWatchdog(audit, evidence=evidence, client=client, env={
                        "META_AD_ACCOUNT_ID": "act_12345", "META_ACCESS_TOKEN": "secret", "DRY_RUN": "true"})
                    result = await guard.cycle()
                    await guard.cycle()
                self.assertEqual(result["status"], "paused_confirmed")
                self.assertEqual((await audit.get_meta_micro_campaign_claim())["campaign_id"], "98765")
                self.assertEqual([r.content for r in requests if r.method == "POST"], [b"status=PAUSED"] * 2)
        asyncio.run(run())

    def test_no_purchase_prevents_every_activation_write(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail("network write forbidden"))) as client:
                    publisher = MetaPublisher(PlanAuditStore(Path(directory) / "audit.sqlite"), client=client, env={})
                    with self.assertRaisesRegex(RuntimeError, "FRESH_PURCHASE_REQUIRED"):
                        await publisher._activate(client, "98765", {})
        asyncio.run(run())

    def test_scope_update_uses_current_credentials_once_without_reinstall_or_secret_overwrite(self):
        async def run():
            grants = []
            env = {"SHOPIFY_STORE_DOMAIN": "homestro.myshopify.com", "SHOPIFY_ACCESS_TOKEN": "old",
                   "SHOPIFY_CLIENT_ID": "existing-app", "SHOPIFY_CLIENT_SECRET": "existing-secret"}
            def handler(request):
                if request.url.path.endswith("/access_token"):
                    grants.append(request)
                    return httpx.Response(200, json={"access_token": "current", "expires_in": 86400})
                if request.headers.get("X-Shopify-Access-Token") == "old":
                    return httpx.Response(200, json={"errors": [{"extensions": {"code": "ACCESS_DENIED"}}]})
                return httpx.Response(200, json={"data": {"orders": {"nodes": [self.order],
                    "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                evidence = PurchaseEvidence(env=env, client=client)
                self.assertTrue((await evidence.check(now=self.now))["verified"])
                self.assertTrue((await evidence.check(now=self.now))["verified"])
            self.assertEqual(len(grants), 1)
            self.assertEqual(env["SHOPIFY_ACCESS_TOKEN"], "old")
        asyncio.run(run())

    def test_resume_reuses_campaign_and_rejects_excess_budget_or_ambiguous_activation(self):
        async def run(budget, ambiguous=False):
            with tempfile.TemporaryDirectory() as directory:
                audit = PlanAuditStore(Path(directory) / "audit.sqlite")
                await audit.claim_meta_micro_campaign("act_12345", "all")
                await audit.update_meta_micro_campaign(status="ACTIVE_PENDING_REVIEW", campaign_id="98765")
                state = "PAUSED"
                writes = []
                def handler(request):
                    nonlocal state
                    if request.method == "POST":
                        self.assertEqual(request.url.path, "/v26.0/98765")
                        writes.append(request.content)
                        state = "ACTIVE" if request.content == b"status=ACTIVE" else "PAUSED"
                        if ambiguous and state == "ACTIVE":
                            return httpx.Response(500)
                        return httpx.Response(200, json={"success": True})
                    if request.url.path.endswith("/adsets"):
                        return httpx.Response(200, json={"data": [{"id": "87654", "daily_budget": budget,
                            "start_time": (self.now - timedelta(hours=1)).isoformat(),
                            "end_time": (self.now + timedelta(days=6)).isoformat(), "status": "ACTIVE",
                            "targeting": {"geo_locations": {"countries": ["DE", "AT"]}}}]})
                    return httpx.Response(200, json={"id": "98765", "status": state, "account_id": "12345",
                        "name": "Homestro Catalog Sales All Products", "objective": "OUTCOME_SALES"})
                evidence = AsyncMock()
                evidence.check.return_value = {"verified": True}
                env = {"ALLOW_MICRO_BUDGET": "true", "DRY_RUN": "false", "PILOT_AD_DRY_RUN": "false",
                    "PILOT_AD_MAX_BUDGET_EUR": "5", "META_ACCESS_TOKEN": "secret", "META_AD_ACCOUNT_ID": "act_12345",
                    "META_PAGE_ID": "12345", "META_PIXEL_ID": "23456", "META_PRODUCT_CATALOG_ID": "34567",
                    "META_DSA_BENEFICIARY": "Homestro", "META_DSA_PAYOR": "Homestro",
                    "META_BILLING_VERIFIED": "true", "META_PURCHASE_EVENT_VERIFIED": "true"}
                readiness = {"status": "checked", "account": {"pixel_access_verified": True,
                    "billing_ready": True, "account_status": "active", "currency": "EUR"}}
                with patch.object(MetaPublisher, "check_readiness", new=AsyncMock(return_value=readiness)):
                    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                        result = await PurchaseWatchdog(audit, evidence=evidence, env=env, client=client).cycle()
                return result, writes, state
        result, writes, state = asyncio.run(run("500"))
        self.assertEqual(result["status"], "active_confirmed")
        self.assertEqual(writes, [b"status=ACTIVE"])
        result, writes, state = asyncio.run(run("1000"))
        self.assertEqual(state, "PAUSED")
        self.assertNotIn(b"status=ACTIVE", writes)
        result, writes, state = asyncio.run(run("500", ambiguous=True))
        self.assertEqual(result["reason"], "CONTROL_FAILED_COMPENSATED")
        self.assertEqual(state, "PAUSED")
