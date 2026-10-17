import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from adtech_pilot.daemon import PilotDaemon
from adtech_pilot.micro_budget import MetaAccountReadiness


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
            self.assertIn("DRY_RUN_ENABLED", result["micro_budget_preflight"]["blockers"])
            self.assertFalse(result["micro_budget_preflight"]["live_submission_enabled"])
            self.assertEqual(result["micro_budget_execution"], "READ_ONLY_PREFLIGHT_ONLY")

        asyncio.run(run())

    def test_one_cycle_runs_independent_jobs_and_records_zero_spend_heartbeat(self):
        async def run():
            stop = asyncio.Event()
            audit = MemoryAudit()

            async def done(name):
                if name == "metrics":
                    stop.set()
                return {"status": "ok", "job": name}

            daemon = PilotDaemon(
                audit,
                heartbeat_interval_seconds=1,
                reporter=FakeReporter(),
                feed_job=lambda: done("feed"),
                merchant_job=lambda: done("merchant"),
                competitor_job=lambda: done("competitor"),
                creative_job=lambda: done("creative"),
                metrics_job=lambda: done("metrics"),
            )
            await daemon.run(stop)
            heartbeat = audit.records[-1][1]
            self.assertEqual(heartbeat["budget_limit_eur"], 0.0)
            self.assertTrue(heartbeat["dry_run"])
            self.assertEqual(len(heartbeat["jobs"]), 5)

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
