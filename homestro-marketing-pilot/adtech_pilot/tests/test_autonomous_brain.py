import asyncio
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
from adtech_pilot.autonomous_brain import (
    AutonomousBrain,
    BrainMemory,
    next_product_batch,
)
from adtech_pilot.media_buyer import PlanAuditStore


def product(index, **extra):
    return {'id': str(index), 'title': f'Produkt {index:03}', 'price': '39.90', 'currency': 'EUR',
            'availability': 'in_stock', 'link': f'https://homestro.de/products/p-{index}',
            'image_link': 'https://cdn.shopify.com/photo.jpg', 'product_type': str(index % 3), **extra}


class AutonomousBrainTests(unittest.TestCase):
    def test_exploration_uses_eligible_least_seen_products_and_distinct_urls(self):
        items = [product(i) for i in range(25)] + [product(30, status='DRAFT'), product(31, availability='out_of_stock'), product(24)]
        batch = next_product_batch(items, {str(i): 1 for i in range(10)})
        self.assertEqual(len(batch), 10)
        self.assertTrue(all(int(p['id']) >= 10 for p in batch))
        self.assertEqual(len({p['link'] for p in batch}), 10)
        self.assertNotIn('30', [p['id'] for p in batch])

    def test_public_longevity_only_prioritizes_equal_exploration_not_prior_winners(self):
        items = [product(i) for i in range(3)]
        trends = [{'product_id': '2', 'observed_longest_ad_age_days': 20}]
        self.assertEqual(next_product_batch(items, {}, limit=1, trend_candidates=trends)[0]['id'], '2')
        self.assertNotEqual(next_product_batch(items, {'2': 1}, limit=1, trend_candidates=trends)[0]['id'], '2')

    def scenario(self, failure=None, age=25, spend=3):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                audit = PlanAuditStore(Path(directory) / 'audit.sqlite')
                await audit.claim_meta_micro_campaign('act_12345', 'all')
                await audit.update_meta_micro_campaign(status='ACTIVE_PENDING_REVIEW', campaign_id='98765')
                now = datetime.now(UTC)
                memory = BrainMemory(audit)
                memory.initialize('98765', {'ad_id': '34567', 'creative_id': '45678', 'inflight': None,
                    'counts': {str(i): 1 for i in range(10)}, 'current_product_ids': [str(i) for i in range(10)],
                    'last_rotation_at': (now - timedelta(hours=age)).isoformat(), 'baseline_spend_eur': 0})
                env = {'ALLOW_MICRO_BUDGET': 'true', 'DRY_RUN': 'false', 'PILOT_AD_DRY_RUN': 'false',
                    'PILOT_AD_MAX_BUDGET_EUR': '5', 'META_ACCESS_TOKEN': 'secret', 'META_AD_ACCOUNT_ID': 'act_12345',
                    'META_PAGE_ID': '4444', 'META_PIXEL_ID': '5555', 'META_DSA_BENEFICIARY': 'Homestro',
                    'META_DSA_PAYOR': 'Homestro', 'META_BILLING_VERIFIED': 'true',
                    'PILOT_LAUNCH_POLICY': 'bounded_acquisition_test', 'PILOT_ACCEPT_UNVERIFIED_MEASUREMENT': 'true',
                    'PILOT_AD_MODE': 'website_sales'}
                creative, creates, attaches = '45678', [], []

                def handler(request):
                    nonlocal creative
                    path = request.url.path.removeprefix('/v26.0/')
                    if request.method == 'POST':
                        values = parse_qs(request.content.decode())
                        self.assertNotIn('daily_budget', values)
                        self.assertNotIn('status', values)
                        if path == 'act_12345/adcreatives':
                            creates.append(values)
                            if failure == 'create':
                                raise httpx.ReadTimeout('lost create response', request=request)
                            return httpx.Response(200, json={'id': '56789'})
                        self.assertEqual(path, '34567')
                        attaches.append(values)
                        creative = json.loads(values['creative'][0])['creative_id']
                        if failure == 'attach' and len(attaches) == 1:
                            raise httpx.ReadTimeout('lost attach response', request=request)
                        return httpx.Response(200, json={'success': True})
                    if path == '98765':
                        return httpx.Response(200, json={'id': '98765', 'account_id': '12345',
                            'name': 'Homestro Website Sales', 'objective': 'OUTCOME_SALES', 'status': 'ACTIVE'})
                    if path == '98765/adsets':
                        return httpx.Response(200, json={'data': [{'id': '23456', 'status': 'ACTIVE',
                            'daily_budget': '500', 'lifetime_budget': '0',
                            'start_time': (now - timedelta(days=1)).isoformat(),
                            'end_time': (now + timedelta(days=6)).isoformat(),
                            'targeting': {'geo_locations': {'countries': ['DE', 'AT']}}}]})
                    if path == '23456/ads':
                        return httpx.Response(200, json={'data': [{'id': '34567', 'status': 'ACTIVE',
                            'effective_status': 'ACTIVE', 'creative': {'id': creative}}]})
                    if path == '98765/insights':
                        return httpx.Response(200, json={'data': [{'campaign_id': '98765', 'account_currency': 'EUR',
                            'spend': str(spend), 'clicks': '10', 'impressions': '200',
                            'date_start': '2026-10-25', 'date_stop': '2026-10-26'}]})
                    self.assertEqual(path, '34567')
                    return httpx.Response(200, json={'id': '34567', 'creative': {'id': creative}, 'effective_status': 'PENDING_REVIEW'})

                async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                    first = await AutonomousBrain(audit, env=env, client=client).cycle([product(i) for i in range(25)], now=now)
                    # A new controller and DB connection simulate a service restart.
                    second = await AutonomousBrain(PlanAuditStore(audit.database_path), env=env, client=client).cycle(
                        [product(i) for i in range(25)], now=now + timedelta(minutes=5))
                return first, second, creates, attaches, memory.state('98765')
        return asyncio.run(run())

    def test_real_transport_rotation_preserves_ad_and_budget_and_does_not_repeat(self):
        first, second, creates, attaches, state = self.scenario()
        self.assertEqual(first['status'], 'rotation_confirmed')
        self.assertEqual(second['reason'], 'MINIMUM_24H_EXPERIMENT')
        self.assertEqual(len(creates), 1)
        self.assertEqual(len(attaches), 1)
        self.assertEqual(state['creative_id'], '56789')
        self.assertTrue(all(int(i) >= 10 for i in state['current_product_ids']))

    def test_lost_create_response_is_never_blindly_retried(self):
        first, second, creates, attaches, _ = self.scenario(failure='create')
        self.assertEqual(first['stage'], 'create_creative')
        self.assertEqual(second['reason'], 'CREATIVE_CREATE_UNCERTAIN_NO_RETRY')
        self.assertEqual(len(creates), 1)
        self.assertEqual(attaches, [])

    def test_lost_attachment_response_reconciles_without_duplicate_creative(self):
        _, second, creates, attaches, state = self.scenario(failure='attach')
        self.assertEqual(second['status'], 'rotation_confirmed')
        self.assertEqual(len(creates), 1)
        self.assertEqual(len(attaches), 1)
        self.assertIsNone(state['inflight'])

    def test_learning_and_minimum_spend_prevent_early_replacement(self):
        for age, spend, reason in ((2, 3, 'MINIMUM_24H_EXPERIMENT'), (25, 1, 'MINIMUM_2_50_EUR_EXPERIMENT_SPEND')):
            first, _, creates, attaches, _ = self.scenario(age=age, spend=spend)
            self.assertEqual(first['reason'], reason)
            self.assertEqual(creates, [])
            self.assertEqual(attaches, [])
