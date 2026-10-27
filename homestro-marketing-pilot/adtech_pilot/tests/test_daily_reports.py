import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from adtech_pilot.daily_reports import DailyMarketingReports
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.organic_bridge import read_operations


class DailyReportTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_provider_inventory_to_durable_report_survives_restart(self):
        now = datetime(2026, 10, 26, 23, 10, tzinfo=UTC)
        source = {'brand': 'Homestro', 'generatedAt': now.isoformat(),
                  'generationPerformed': False, 'newPublicationConfirmed': False,
                  'catalog': {'records': 239}, 'media': {'sourceImages': 3578, 'nativeVideoProducts': 4,
                  'importedImages': 11, 'importedVideos': 1},
                  'receipts': [{'channel': 'instagram', 'mediaKind': 'video', 'status': 'approved',
                                'scheduledFor': now.isoformat()}], 'openai': {'status': 'blocked'}}

        def response(request):
            self.assertEqual(request.method, 'GET')
            self.assertEqual(request.headers['Authorization'], 'Bearer test-internal')
            self.assertEqual(request.url.path, '/api/marketing/v2/operations')
            return httpx.Response(200, json=source)

        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            observed = await read_operations(env={'PILOT_ORGANIC_API_KEY': 'test-internal'}, client=client, now=now)
        self.assertEqual(observed['scheduled_receipts'], 1)
        self.assertEqual(observed['counts']['importedVideos'], 1)
        self.assertFalse(observed['publication_confirmed'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audit.sqlite'
            audit = PlanAuditStore(path)
            await audit.record('organic_operations', observed)
            evidence = await audit.latest_brain_evidence()
            evidence['organic_operations']['created_at'] = now.isoformat()
            reports = DailyMarketingReports(audit)
            result = reports.refresh(evidence, now=now)
            self.assertEqual(result['day'], '2026-10-27')
            self.assertEqual(result['sections']['organic_operations']['status'], 'fresh')
            self.assertIsNone(result['total_net_profit_eur'])
            restarted = DailyMarketingReports(PlanAuditStore(path))
            self.assertEqual(restarted.get('2026-10-27'), result)
            stale = restarted.refresh(evidence, now=now + timedelta(hours=2))
            self.assertEqual(stale['sections']['organic_operations']['status'], 'historical_or_invalid_time')
            self.assertEqual(stale['sections']['cross_channel_accounting']['status'], 'unknown')
            self.assertFalse(stale['budget_increase_authorized'])
            self.assertEqual(restarted.get('2026-10-28')['status'], 'not_observed')
            with self.assertRaises(ValueError):
                restarted.get("2026-10-27' OR 1=1")

    async def test_stale_cross_brand_invalid_counts_and_invalid_schedules_are_not_evidence(self):
        now = datetime.now(UTC)
        valid = {'brand': 'Homestro', 'generatedAt': now.isoformat(), 'generationPerformed': False,
                 'newPublicationConfirmed': False, 'catalog': {'records': 1},
                 'media': dict.fromkeys(('sourceImages', 'nativeVideoProducts', 'importedImages', 'importedVideos'), 0), 'receipts': []}
        cases = [{**valid, 'brand': 'MS Handwerk'}, {**valid, 'generatedAt': (now - timedelta(days=1)).isoformat()},
                 {**valid, 'catalog': {'records': True}},
                 {**valid, 'receipts': [{'channel': 'instagram', 'mediaKind': 'video', 'status': 'draft_queued', 'scheduledFor': now.isoformat()}]}]
        for value in cases:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=value))) as client:
                result = await read_operations(env={'PILOT_ORGANIC_API_KEY': 'internal'}, client=client, now=now)
            self.assertEqual(result['status'], 'unavailable')
            self.assertFalse(result['writes_performed'])
        self.assertEqual((await read_operations(env={}))['status'], 'not_configured')
