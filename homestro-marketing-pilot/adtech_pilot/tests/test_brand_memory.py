import tempfile
import unittest
from pathlib import Path

from adtech_pilot.brand_memory import BrandMemory
from adtech_pilot.marketing_director import MarketingDirector
from adtech_pilot.media_buyer import PlanAuditStore


class BrandMemoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.memory = BrandMemory(self.audit)
        self.entry = {'id': 'voice', 'kind': 'voice', 'text_de': 'Klar und sachlich formulieren.',
                      'source_url': 'https://homestro.de/', 'reviewed': True}

    def test_restart_idempotency_and_stale_update_conflict(self):
        empty = self.memory.read()
        saved = self.memory.replace([self.entry], expected_revision=empty['revision'])
        self.assertEqual(BrandMemory(self.audit).read(), saved)
        self.assertEqual(self.memory.replace([self.entry], expected_revision=saved['revision']), saved)
        with self.assertRaisesRegex(ValueError, 'REVISION_CONFLICT'):
            self.memory.replace([], expected_revision=empty['revision'])
        restored = self.memory.replace([], expected_revision=saved['revision'])
        self.assertEqual(restored['entries'], [])

    def test_product_claim_requires_exact_product_and_source_revision(self):
        fact = {**self.entry, 'kind': 'product_fact', 'product_id': '123', 'source_revision': 'a' * 64}
        self.memory.replace([fact], expected_revision=self.memory.read()['revision'])
        for context in (self.memory.context(), self.memory.context(product_id='456', source_revision='a' * 64),
                        self.memory.context(product_id='123', source_revision='b' * 64)):
            self.assertEqual(context['entries'], [])
        context = self.memory.context(product_id='123', source_revision='a' * 64)
        self.assertEqual(len(context['entries']), 1)
        self.assertFalse(context['publication_authorized'])
        self.assertFalse(context['paid_generation_authorized'])

    def test_invalid_unreviewed_foreign_source_and_duplicate_facts_rejected(self):
        for entries in ([{**self.entry, 'reviewed': False}], [{**self.entry, 'source_url': 'https://evil.example/'}],
                        [{**self.entry, 'source_url': 'https://homestro.de/?token=secret'}],
                        [{**self.entry, 'source_url': 'https://user@homestro.de/'}],
                        [{**self.entry, 'source_url': 'https://homestro.de:444/'}],
                        [{**self.entry, 'kind': 'product_fact'}], [self.entry, self.entry],
                        [{**self.entry, 'spend_authorized': True}]):
            with self.assertRaises(ValueError):
                self.memory.replace(entries, expected_revision=self.memory.read()['revision'])
        self.assertEqual(self.memory.read()['entries'], [])

    def test_changed_memory_invalidates_drafts_without_claiming_publication(self):
        director = MarketingDirector(self.audit)
        product = {'id': '123', 'title': 'Aufbewahrungsbox', 'price': '39.90', 'currency': 'EUR',
                   'availability': 'in_stock', 'link': 'https://homestro.de/products/box',
                   'image_link': 'https://cdn.shopify.com/box.jpg'}
        director.reconcile([product], {})
        old_ids = {task['id'] for task in director.report()['tasks']}
        self.memory.replace([self.entry], expected_revision=self.memory.read()['revision'])
        director.reconcile([product], {})
        tasks = director.report()['tasks']
        self.assertEqual(len(tasks), 7)
        self.assertTrue(old_ids.isdisjoint({task['id'] for task in tasks}))
        for task in tasks:
            self.assertEqual(task['brand_context']['evidence_ids'], ['brand:voice'])
            self.assertFalse(task['publication_confirmed'])
