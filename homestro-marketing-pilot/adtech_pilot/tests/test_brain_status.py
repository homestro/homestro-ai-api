import asyncio
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from adtech_pilot.brain_status import operating_report
from adtech_pilot.media_buyer import PlanAuditStore


class BrainStatusTests(unittest.TestCase):
    def test_active_does_not_imply_delivery_profit_or_full_readiness(self):
        result = operating_report({}, {'status': 'ACTIVE_PENDING_REVIEW', 'campaign_id': '12345'}, daily_cap_eur=5)
        self.assertEqual(result['next_action'], 'WAIT_FOR_REPORTED_DELIVERY_DATA')
        self.assertFalse(result['full_autonomous_profit_optimization_verified'])
        self.assertFalse(result['budget_increase_authorized'])
        self.assertIn('META_DELIVERY_EVIDENCE', result['remaining_dependencies'])

    def test_durable_stop_wins_and_stale_brain_cannot_claim_current_control(self):
        now = datetime.now(UTC)
        evidence = {'autonomous_brain': {'created_at': (now - timedelta(hours=1)).isoformat(),
            'payload': {'status': 'rotation_confirmed'}}}
        self.assertEqual(operating_report(evidence, None, daily_cap_eur=5, now=now)['next_action'], 'BRAIN_EVIDENCE_STALE_CHECK_REQUIRED')
        self.assertEqual(operating_report(evidence, {'status': 'STOPPED_TEST_BUDGET'}, daily_cap_eur=5, now=now)['next_action'], 'KEEP_MANAGED_TEST_PAUSED')

    def test_confirmed_tracking_memory_survives_learning_report_without_false_missing_dependency(self):
        result = operating_report({'brain_memory': {'payload': {'tracking_installed': True}},
            'autonomous_brain': {'created_at': datetime.now(UTC).isoformat(),
                                'payload': {'status': 'learning', 'reason': 'MINIMUM_24H_EXPERIMENT'}}},
            {'status': 'ACTIVE_PENDING_REVIEW'}, daily_cap_eur=5)
        self.assertNotIn('SIGNED_TRACKING_ATTACHMENT', result['remaining_dependencies'])
        self.assertNotIn('brain_memory', result['stale_sources'])

    def test_status_reads_latest_per_kind_not_only_last_few_audit_rows(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                audit = PlanAuditStore(Path(directory) / 'audit.sqlite')
                await audit.record('autonomous_brain', {'status': 'learning', 'reason': 'MINIMUM_24H_EXPERIMENT'})
                for _ in range(205):
                    await audit.record('purchase_watchdog', {'status': 'active_bounded_acquisition_test'})
                latest = await audit.latest_brain_evidence()
                self.assertEqual(latest['autonomous_brain']['payload']['status'], 'learning')
                self.assertNotIn('optimization_plan', latest)
        asyncio.run(run())
