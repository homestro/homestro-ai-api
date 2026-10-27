import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from adtech_pilot.marketing_director import MarketingDirector, campaign_pack
from adtech_pilot.media_buyer import PlanAuditStore


class DirectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.director = MarketingDirector(self.audit)
        self.product = {'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox',
            'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
            'link': 'https://homestro.de/products/box?variant=123', 'image_link': 'https://cdn.shopify.com/box.jpg'}
        self.evidence = {'claim': {'campaign_id': '123456', 'status': 'ACTIVE_PENDING_REVIEW'},
                         'controller': {'next_action': 'RUN_CREATIVE_CYCLE'}}
        self.now = datetime(2026, 10, 25, 23, 30, tzinfo=UTC)

    def test_restart_keeps_stable_tasks_and_semantic_cost_timestamp_refresh_does_not_duplicate(self):
        result = self.director.reconcile([self.product], self.evidence, now=self.now)
        self.assertEqual(result['new_tasks'], 7)
        result = MarketingDirector(self.audit).reconcile([{**self.product, 'pilot_cost_observed_at': 'new'}], self.evidence, now=self.now)
        self.assertEqual(result['new_tasks'], 0)
        self.assertEqual(len(self.director.report()['tasks']), 7)

    def test_calendar_uses_berlin_day_and_does_not_claim_publications(self):
        result = self.director.reconcile([self.product], self.evidence, now=self.now)
        self.assertEqual(result['calendar'][0]['date'], '2026-10-26')
        self.assertTrue(result['queue_is_not_publication'])
        for task in self.director.report(now=self.now)['tasks']:
            self.assertFalse(task['publication_confirmed'])
            self.assertIsNone(task['receipt'])

    def test_changed_product_supersedes_previous_proposals_without_duplicate_active_tasks(self):
        self.director.reconcile([self.product], self.evidence, now=self.now)
        self.director.reconcile([{**self.product, 'price': '42.00'}], self.evidence, now=self.now)
        tasks = self.director.report(now=self.now)['tasks']
        self.assertEqual(len(tasks), 7)
        self.assertEqual([t for t in tasks if t['kind'] == 'seo_geo'][0]['content']['geo']['product_json_ld']['offers']['price'], '42.00')

    def test_unavailable_or_removed_product_retires_prior_drafts(self):
        self.director.reconcile([self.product], self.evidence, now=self.now)
        result = self.director.reconcile([{**self.product, 'availability': 'out_of_stock'}], self.evidence, now=self.now)
        self.assertEqual(result['distinct_eligible_products'], 0)
        self.assertEqual(self.director.report(now=self.now)['tasks'], [])

    def test_durable_stop_wins_and_other_channels_never_acquire_paid_budget(self):
        self.evidence['claim']['status'] = 'STOPPED_TEST_BUDGET'
        result = self.director.reconcile([self.product], self.evidence, now=self.now)
        self.assertEqual(result['next_action'], 'KEEP_DURABLE_STOP')
        for task in self.director.report(now=self.now)['tasks']:
            if task['kind'] in {'google_search', 'bing_search'}:
                self.assertEqual(task['content']['daily_budget_eur'], 0)
                self.assertEqual(task['state'], 'blocked')
            if task['kind'] == 'meta_experiment':
                self.assertIn('DURABLE_CAMPAIGN_STOP', task['blockers'])

    def test_email_is_recipient_free_draft_and_landing_escapes_untrusted_text(self):
        pack = campaign_pack({**self.product, 'title': 'Box & "test"'})
        self.assertFalse(pack['email_sequence']['send_enabled'])
        self.assertEqual(pack['email_sequence']['recipient_count'], 0)
        self.assertIn('Box &amp; &quot;test&quot;', pack['landing_content']['body_html'])
        self.assertIsNone(pack['google_search']['search_volume'])

    def test_staleness_is_explicit_and_missing_budget_or_sale_is_not_fabricated(self):
        self.director.reconcile([self.product], self.evidence, now=self.now)
        self.assertTrue(all(t['stale'] for t in self.director.report(now=self.now + timedelta(hours=7))['tasks']))
        self.assertFalse(self.director.report()['full_vendor_parity_verified'])

    def test_multiple_variants_do_not_make_duplicate_product_campaign_packs(self):
        result = self.director.reconcile([self.product, {**self.product, 'id': '124',
            'link': 'https://homestro.de/products/box?variant=124'}], self.evidence, now=self.now)
        self.assertEqual(result['distinct_eligible_products'], 1)
        self.assertEqual(result['new_tasks'], 7)

    def test_exact_consumer_source_receipt_advances_social_work_and_survives_outage_as_history(self):
        self.evidence['catalog_work'] = {'status': 'observed', 'enabled': True, 'generated_at': self.now.isoformat(),
            'products': [{'product_id': 'gid://shopify/Product/999', 'revision': 'source-v2', 'eligible': True,
                'source_url': self.product['link'], 'receipts': [{'channel': 'instagram', 'status': 'approved', 'count': 1}]}]}
        result = self.director.reconcile([self.product], self.evidence, now=self.now)
        task = next(t for t in self.director.report(now=self.now)['tasks'] if t['kind'] == 'social_content')
        self.assertEqual(task['state'], 'consumer_evidence_observed')
        self.assertEqual(task['receipt']['source_revision'], 'source-v2')
        self.assertTrue(task['receipt']['fresh'])
        self.assertFalse(task['publication_confirmed'])
        self.assertNotIn('EXISTING_ORGANIC_CONSUMER_RECEIPT', result['integration_dependencies'])
        self.evidence['catalog_work'] = {'status': 'unavailable'}
        self.director.reconcile([self.product], self.evidence, now=self.now + timedelta(minutes=5))
        task = next(t for t in self.director.report(now=self.now)['tasks'] if t['kind'] == 'social_content')
        self.assertEqual(task['state'], 'blocked')
        self.assertEqual(task['receipt']['source_revision'], 'source-v2')
        self.assertFalse(task['receipt']['fresh'])

    def test_aggregate_or_stale_or_other_product_cannot_resolve_social_dependencies(self):
        for patch in ({'products': []}, {'generated_at': (self.now-timedelta(hours=2)).isoformat()},
                      {'products': [{'source_url': 'https://homestro.de/products/other', 'eligible': True,
                          'revision': 'r', 'product_id': 'gid://shopify/Product/2',
                          'receipts': [{'channel': 'instagram', 'status': 'published', 'count': 50}]}]}):
            self.evidence['catalog_work'] = {'status': 'observed', 'enabled': True, 'generated_at': self.now.isoformat(),
                'catalog_records': 300, 'counts': [{'state': 'prepared', 'count': 300}], **patch}
            self.director.reconcile([self.product], self.evidence, now=self.now)
            task = next(t for t in self.director.report(now=self.now)['tasks'] if t['kind'] == 'social_content')
            self.assertEqual(task['state'], 'blocked')
            self.assertIsNone(task['receipt'])

    def test_implemented_search_adapters_are_not_falsely_reported_as_missing(self):
        self.evidence['search_channels'] = {'google': {'status': 'observed'}, 'microsoft': {'status': 'not_configured'}}
        self.director.reconcile([self.product], self.evidence, now=self.now)
        tasks = {t['kind']: t for t in self.director.report(now=self.now)['tasks']}
        self.assertEqual(tasks['google_search']['blockers'], ['ADDITIONAL_CHANNEL_SPEND_NOT_AUTHORIZED'])
        self.assertIn('MICROSOFT_ADS_ACCOUNT_CONNECTION_UNVERIFIED', tasks['bing_search']['blockers'])
        self.assertFalse(any('RUNTIME_ADAPTER' in b for task in tasks.values() for b in task['blockers']))
