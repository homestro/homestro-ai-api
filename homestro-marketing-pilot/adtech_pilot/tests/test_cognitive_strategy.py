import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

import httpx
from adtech_pilot.cognitive_strategy import CognitiveStrategy, StrategyThought
from adtech_pilot.creative_factory import OpenAIProvider
from adtech_pilot.marketing_director import MarketingDirector
from adtech_pilot.media_buyer import PlanAuditStore


class CognitiveTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.brain = CognitiveStrategy(self.audit)
        self.product = {'id': '123', 'title': 'Aufbewahrungsbox', 'price': '39.90', 'currency': 'EUR',
            'availability': 'in_stock', 'link': 'https://homestro.de/products/box', 'image_link': 'https://cdn.shopify.com/box.jpg'}
        self.env = {'PILOT_REASONING_ENABLED': 'true', 'PILOT_REASONING_COST_APPROVED': 'true'}
        self.now = datetime.now(UTC)
        self.calls = 0
        outer = self
        class Provider:
            async def complete(self, *, schema, prompt):
                outer.calls += 1
                outer.assertNotIn('OPENAI_API_KEY', prompt)
                return schema.model_validate({'summary_de': 'Produktdetails als redaktionelle Hypothese prüfen.',
                    'proposals': [{'product_id': '123', 'channel': 'social', 'action': 'draft_content',
                        'rationale_de': 'Vorhandene Produktdaten nutzen.', 'evidence_ids': ['123']}]})
        self.provider = Provider()

    async def test_disabled_without_both_cost_flags_never_calls_provider(self):
        for env in ({}, {'PILOT_REASONING_ENABLED': 'true'}):
            result = await self.brain.cycle([self.product], controller={}, env=env, provider=self.provider)
            self.assertEqual(result['status'], 'disabled')
        self.assertEqual(self.calls, 0)

    async def test_once_per_day_persists_across_restart_and_changes_editorial_priority_only(self):
        result = await self.brain.cycle([self.product], controller={}, env=self.env, provider=self.provider, now=self.now)
        self.assertEqual(result['status'], 'proposal_recorded')
        self.assertFalse(result['decision']['budget_writes'])
        cached = await CognitiveStrategy(self.audit).cycle([self.product], controller={}, env=self.env, provider=self.provider, now=self.now)
        self.assertTrue(cached['cached'])
        self.assertEqual(self.calls, 1)
        director = MarketingDirector(self.audit)
        strategy = director.reconcile([self.product], {'cognitive': result}, now=self.now)
        self.assertFalse(strategy['budget_increase_authorized'])
        self.assertEqual(director.report(now=self.now)['tasks'][0]['source_product_id'], '123')

    async def test_unknown_product_or_evidence_is_rejected_and_not_retried(self):
        class Bad:
            async def complete(self, **kwargs):
                return {'summary_de': 'Neověřená hypotéza', 'proposals': [{'product_id': 'unknown',
                    'channel': 'meta', 'action': 'hold', 'rationale_de': 'Unknown source', 'evidence_ids': ['invented']} ]}
        result = await self.brain.cycle([self.product], controller={}, env=self.env, provider=Bad(), now=self.now)
        self.assertEqual(result['status'], 'unavailable_no_retry_today')
        result = await self.brain.cycle([self.product], controller={}, env=self.env, provider=self.provider, now=self.now)
        self.assertTrue(result['cached'])
        self.assertEqual(self.calls, 0)

    async def test_lost_provider_response_reserves_day_and_never_blindly_replays(self):
        class Lost:
            async def complete(self, **kwargs):
                raise httpx.ReadTimeout('lost')
        await self.brain.cycle([self.product], controller={}, env=self.env, provider=Lost(), now=self.now)
        result = await self.brain.cycle([self.product], controller={}, env=self.env, provider=self.provider, now=self.now)
        self.assertTrue(result['cached'])
        self.assertEqual(self.calls, 0)

    async def test_bounded_adapter_transmits_output_and_standard_tier_limits(self):
        def handle(request):
            body = json.loads(request.content)
            self.assertEqual(body['max_output_tokens'], 1500)
            self.assertEqual(body['service_tier'], 'default')
            payload = {'summary_de': 'Hypothese zur Prüfung.', 'proposals': []}
            return httpx.Response(200, json={'output': [{'content': [{'type': 'output_text', 'text': json.dumps(payload)}]}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = OpenAIProvider('test', text_model='gpt-6-luna', client=client,
                max_output_tokens=1500, request_byte_limit=24000, service_tier='default')
            result = await provider.complete(schema=StrategyThought, prompt='Test')
            self.assertEqual(result.proposals, [])

    async def test_oversize_request_rejected_before_network(self):
        def handle(_):
            self.fail('Oversize request reached provider')
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            provider = OpenAIProvider('test', client=client, request_byte_limit=20)
            with self.assertRaises(ValueError):
                await provider.complete(schema=StrategyThought, prompt='Test')
