import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from adtech_pilot.daemon import PilotDaemon
from adtech_pilot.micro_budget import MetaAccountReadiness
from adtech_pilot.shopify_catalog import ShopifyVariantMargin


class MemoryAudit:
    def __init__(self):
        self.records = []

    async def record(self, kind, payload):
        self.records.append((kind, payload))
        return str(len(self.records))


class FakeReporter:
    async def publish(self, report):
        return "COMMENT_UPDATED"


class DaemonTests(unittest.TestCase):
    def test_metrics_job_runs_read_only_meta_ads_preflight_and_keeps_spend_blocked(self):
        async def run():
            readiness = MetaAccountReadiness(
                account_id="act_12345",
                account_status="active",
                currency="EUR",
                billing_ready=False,
                page_id="4444",
                pixel_id="5555",
                pixel_access_verified=False,
                purchase_event_verified=False,
            )
            with patch.dict(
                "os.environ",
                {
                    "ALLOW_MICRO_BUDGET": "false",
                    "DRY_RUN": "true",
                    "META_ACCESS_TOKEN": "test-token",
                    "META_AD_ACCOUNT_ID": "act_12345",
                    "META_PAGE_ID": "4444",
                    "META_PIXEL_ID": "5555",
                },
                clear=False,
            ), patch("adtech_pilot.daemon.MetaPublisher") as publisher_cls:
                publisher_cls.return_value.check_readiness = AsyncMock(
                    return_value={"status": "checked", "account": readiness.model_dump()}
                )
                result = await PilotDaemon(MemoryAudit())._metrics_job()
            publisher_cls.return_value.check_readiness.assert_awaited_once()
            self.assertEqual(result["meta_ads_preflight"]["status"], "checked")
            self.assertIn("DRY_RUN_ENABLED", result["optimizer_micro_budget_preflight"]["blockers"])
            self.assertFalse(result["optimizer_micro_budget_preflight"]["live_submission_enabled"])
            self.assertEqual(result["micro_budget_execution"], "READ_ONLY_PREFLIGHT_ONLY")

        asyncio.run(run())

    def test_one_cycle_reports_campaign_budget_separately_from_optimizer(self):
        async def run():
            stop = asyncio.Event()
            audit = MemoryAudit()

            async def done(name):
                if name == "metrics":
                    stop.set()
                return {"status": "ok", "job": name}

            with patch.dict(
                "os.environ",
                {
                    "DRY_RUN": "false",
                    "PILOT_AD_DRY_RUN": "false",
                    "PILOT_AD_MAX_BUDGET_EUR": "5.0",
                    "ALLOW_MICRO_BUDGET": "true",
                },
                clear=False,
            ):
                daemon = PilotDaemon(
                    audit,
                    heartbeat_interval_seconds=1,
                    reporter=FakeReporter(),
                    feed_job=lambda: done("feed"),
                    shopify_catalog_job=lambda: done("shopify"),
                    merchant_job=lambda: done("merchant"),
                    competitor_job=lambda: done("competitor"),
                    creative_job=lambda: done("creative"),
                    metrics_job=lambda: done("metrics"),
                )
                await daemon.run(stop)
            heartbeat = audit.records[-1][1]
            self.assertEqual(heartbeat["budget_limit_eur"], 5.0)
            self.assertFalse(heartbeat["dry_run"])
            self.assertEqual(heartbeat["planned_total_budget_eur"], 35.0)
            self.assertTrue(heartbeat["micro_budget_submission_enabled"])
            self.assertTrue(heartbeat["optimizer"]["dry_run"])
            self.assertEqual(heartbeat["optimizer"]["budget_limit_eur"], 0.0)
            self.assertEqual(len(heartbeat["jobs"]), 6)
            self.assertEqual(heartbeat["jobs"]["shopify_catalog"]["job"], "shopify")

        asyncio.run(run())

    def test_shopify_catalog_job_loads_verified_variants_read_only(self):
        async def run():
            audit = MemoryAudit()
            variant = ShopifyVariantMargin(
                product_id="gid://shopify/Product/1",
                product_title="Test product",
                product_handle="test-product",
                variant_id="gid://shopify/ProductVariant/2",
                sku="SKU-2",
                inventory_quantity=4,
                price="20.00",
                unit_cost="10.00",
                currency="EUR",
                gross_margin_ratio="0.50",
            )
            with patch.dict(
                "os.environ",
                {"SHOPIFY_STORE_URL": "homestro.myshopify.com", "SHOPIFY_ACCESS_TOKEN": "test-token"},
                clear=False,
            ), patch("adtech_pilot.daemon.ShopifyCatalogClient") as client_cls:
                client_cls.return_value.fetch_margin_qualified_variants = AsyncMock(
                    return_value=[variant]
                )
                daemon = PilotDaemon(audit)
                result = await daemon._shopify_catalog_job()
            self.assertEqual(result["status"], "catalog_loaded")
            self.assertEqual(result["margin_and_stock_qualified_variants"], 1)
            self.assertFalse(result["ad_mutations_performed"])
            self.assertEqual(daemon._latest_catalog_variants[0]["sku"], "SKU-2")
            self.assertEqual(audit.records[0][0], "shopify_catalog_diagnostics")

        asyncio.run(run())

    def test_job_failure_is_isolated_and_backoff_is_recorded(self):
        async def run():
            stop = asyncio.Event()
            audit = MemoryAudit()
            calls = {"feed": 0}

            async def broken():
                calls["feed"] += 1
                raise RuntimeError(
                    "provider response contains secret and must not be logged"
                )

            async def finish():
                stop.set()
                return {"status": "ok"}

            daemon = PilotDaemon(
                audit,
                heartbeat_interval_seconds=1,
                feed_job=broken,
                merchant_job=finish,
                competitor_job=finish,
                creative_job=finish,
                metrics_job=finish,
                random_uniform=lambda _low, _high: 1.0,
            )
            await daemon.run(stop)
            self.assertEqual(calls["feed"], 1)
            heartbeat = audit.records[-1][1]
            self.assertEqual(
                heartbeat["jobs"]["feed_diagnostics"]["status"], "retry_scheduled"
            )
            self.assertEqual(heartbeat["jobs"]["feed_diagnostics"]["retry_seconds"], 30)
            self.assertEqual(heartbeat["jobs"]["competitor_scan"]["status"], "ok")

        asyncio.run(run())
