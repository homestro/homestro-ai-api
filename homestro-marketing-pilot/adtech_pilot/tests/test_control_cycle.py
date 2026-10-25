import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

from adtech_pilot.control_cycle import control_plan


class ControlCycleTests(unittest.TestCase):
    def plan(self, **changes):
        return control_plan(**{'product_count': 384, 'feed_age_seconds': 60, 'metrics_age_seconds': 60,
            'performance_status': 'collected', 'campaign_status': 'ACTIVE_PENDING_REVIEW',
            'live_enabled': True, 'daily_cap_eur': 5, **changes})

    def test_real_evidence_dispatches_existing_cycle_without_budget_or_generation_authorization(self):
        result = self.plan()
        self.assertTrue(result['creative_cycle_allowed'])
        self.assertFalse(result['budget_increase_authorized'])
        self.assertFalse(result['paid_generation_authorized'])

    def test_prior_sale_is_not_required_to_launch_first_campaign(self):
        self.assertTrue(self.plan(performance_status='no_managed_campaign', campaign_status=None)['creative_cycle_allowed'])

    def test_stale_product_or_metric_data_blocks_changes(self):
        for changes, reason in (({'product_count': 0}, 'NO_VERIFIED_PRODUCT_SNAPSHOT'),
                                ({'feed_age_seconds': 21601}, 'PRODUCT_SNAPSHOT_STALE'),
                                ({'metrics_age_seconds': 901}, 'METRICS_SNAPSHOT_STALE'),
                                ({'performance_status': 'unavailable'}, 'METRICS_PROVIDER_NOT_READABLE')):
            result = self.plan(**changes)
            self.assertFalse(result['creative_cycle_allowed'])
            self.assertEqual(result['reason'], reason)

    def test_stop_dry_run_and_budget_authorization_cannot_be_overridden_by_data(self):
        for changes in ({'campaign_status': 'STOPPED_PERFORMANCE'}, {'live_enabled': False},
                        {'daily_cap_eur': 100}, {'daily_cap_eur': float('nan')}):
            self.assertFalse(self.plan(**changes)['creative_cycle_allowed'])


class ControlDispatchTests(unittest.TestCase):
    def test_stale_metrics_prevent_actual_publisher_call(self):
        from adtech_pilot.daemon import PilotDaemon
        from adtech_pilot.tests.test_daemon import MemoryAudit

        async def run():
            daemon = PilotDaemon(MemoryAudit())
            daemon._latest_products = [{'id': '123', 'link': 'https://homestro.de/products/test'}]
            daemon._evidence_times['feed_diagnostics'] = time.monotonic()
            with patch.dict('os.environ', {'ALLOW_MICRO_BUDGET': 'true', 'DRY_RUN': 'false',
                'PILOT_AD_DRY_RUN': 'false', 'PILOT_AD_MAX_BUDGET_EUR': '5'}), patch('adtech_pilot.daemon.MetaPublisher') as publisher:
                publisher.return_value.reconcile_retired_campaign = AsyncMock(return_value={'status': 'not_applicable'})
                publisher.return_value.publish_one = AsyncMock()
                result = await daemon._creative_job()
                publisher.return_value.publish_one.assert_not_awaited()
            self.assertEqual(result['reason'], 'METRICS_SNAPSHOT_STALE')
            self.assertEqual(daemon._next_run['media_buying_plan'], 0)
        asyncio.run(run())

    def test_scheduler_reads_performance_before_creative_consumer(self):
        from adtech_pilot.daemon import PilotDaemon
        from adtech_pilot.tests.test_daemon import MemoryAudit

        async def run():
            stop, calls = asyncio.Event(), []
            async def job(name):
                calls.append(name)
                if name == 'creative':
                    stop.set()
                return {'status': 'ok'}
            daemon = PilotDaemon(MemoryAudit(), feed_job=lambda: job('feed'), merchant_job=lambda: job('merchant'),
                competitor_job=lambda: job('trends'), metrics_job=lambda: job('metrics'),
                creative_job=lambda: job('creative'), catalog_job=lambda: job('catalog'))
            await daemon.run(stop)
            self.assertLess(calls.index('feed'), calls.index('metrics'))
            self.assertLess(calls.index('metrics'), calls.index('creative'))
        asyncio.run(run())
