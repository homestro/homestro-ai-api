import asyncio
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from adtech_pilot.media_buyer import MetaPublisher, PlanAuditStore
from adtech_pilot.purchase_guard import PurchaseWatchdog


class TestSpendStop(unittest.TestCase):
    def test_total_spend_stop_persists_and_cannot_resume_after_restart(self):
        async def run(spend, first_reason, restart_reason):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'audit.sqlite'
                audit = PlanAuditStore(path)
                await audit.claim_meta_micro_campaign('act_12345', 'all')
                await audit.update_meta_micro_campaign(status='ACTIVE_PENDING_REVIEW', campaign_id='98765')
                writes = []
                now = datetime.now(UTC)

                def handler(request):
                    if request.method == 'POST':
                        writes.append(request.content)
                        return httpx.Response(200, json={'success': True})
                    if request.url.path.endswith('/adsets'):
                        return httpx.Response(200, json={'data': [{'daily_budget': '500', 'lifetime_budget': '0',
                            'status': 'ACTIVE', 'start_time': (now + timedelta(minutes=10)).isoformat(),
                            'end_time': (now + timedelta(minutes=10, days=7)).isoformat(),
                            'targeting': {'geo_locations': {'countries': ['AT', 'DE']}}}]})
                    return httpx.Response(200, json={'id': '98765', 'account_id': '12345',
                        'name': 'Homestro Catalog Sales All Products', 'objective': 'OUTCOME_SALES', 'status': 'PAUSED'})

                env = {'PILOT_LAUNCH_POLICY': 'bounded_acquisition_test', 'ALLOW_MICRO_BUDGET': 'true',
                    'DRY_RUN': 'false', 'PILOT_AD_DRY_RUN': 'false', 'META_ACCESS_TOKEN': 'secret',
                    'META_AD_ACCOUNT_ID': 'act_12345', 'PILOT_PAYMENT_DB_PATH': str(Path(directory) / 'payments.sqlite')}
                evidence = AsyncMock()
                evidence.check.return_value = {'verified': False}
                metrics = AsyncMock(return_value={'status': 'collected', 'metrics': [{'spend_eur': spend, 'reported_purchases': 0, 'reported_purchase_value_eur': 0}]})
                with patch.object(MetaPublisher, '_configuration', return_value=()), patch(
                    'adtech_pilot.performance_loader.load_meta_performance', new=metrics):
                    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                        first = await PurchaseWatchdog(audit, evidence=evidence, env=env, client=client).cycle()
                        second = await PurchaseWatchdog(PlanAuditStore(path), evidence=evidence, env=env, client=client).cycle()
                self.assertEqual(first['reason'], first_reason)
                self.assertEqual(second['reason'], restart_reason)
                self.assertEqual(metrics.await_count, 1)
                self.assertEqual(writes, [b'status=PAUSED', b'status=PAUSED'])
        asyncio.run(run(35, 'TEST_TOTAL_BUDGET_REACHED', 'TEST_TOTAL_BUDGET_REACHED'))
        asyncio.run(run(15.01, 'SPEND_OVER_15_WITH_NO_REPORTED_PURCHASE', 'PERFORMANCE_STOP_LATCHED'))
