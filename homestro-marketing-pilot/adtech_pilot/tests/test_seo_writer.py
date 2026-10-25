import copy
import tempfile
import unittest
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.seo_writer import READ, WRITE, SEORevisionWriter


class SEOWriterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.raw = {'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox',
                    'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
                    'link': 'https://homestro.de/products/box?variant=123',
                    'image_link': 'https://cdn.shopify.com/box.jpg'}
        self.product = {'id': 'gid://shopify/Product/456', 'title': 'Aufbewahrungsbox',
                        'handle': 'box', 'status': 'ACTIVE', 'onlineStoreUrl': 'https://homestro.de/products/box',
                        'updatedAt': '2026-10-25T12:00:00Z', 'seo': {'title': None, 'description': None}}
        self.calls = []
        self.writer = SEORevisionWriter(self.audit)

    async def graphql(self, query, variables):
        self.calls.append((query, variables))
        if query == READ:
            return {'productVariant': {'product': copy.deepcopy(self.product)}}
        self.assertEqual(query, WRITE)
        self.assertEqual(set(variables['product']), {'id', 'seo'})
        self.product['seo'].update(variables['product']['seo'])
        return {'productUpdate': {'product': self.product, 'userErrors': []}}

    async def test_backup_before_write_and_readback_then_restart_no_repeat(self):
        async def checked(query, variables):
            if query == WRITE:
                saved = self.writer.load(self.product['id'])
                self.assertEqual(saved['status'], 'pending')
                self.assertIsNone(saved['before']['title'])
            return await self.graphql(query, variables)
        result = await self.writer.revise(self.raw, checked)
        self.assertEqual(result['status'], 'confirmed')
        restarted = SEORevisionWriter(self.audit)
        self.assertEqual((await restarted.revise(self.raw, self.graphql))['status'], 'preserved')
        self.assertEqual(sum(query == WRITE for query, _ in self.calls), 1)

    async def test_existing_fields_preserved_partial_patch_only(self):
        self.product['seo']['title'] = 'Rucne upraveny titulek'
        result = await self.writer.revise(self.raw, self.graphql)
        self.assertEqual(result['fields'], ['description'])
        self.assertEqual(self.product['seo']['title'], 'Rucne upraveny titulek')

    async def test_fully_existing_seo_no_mutation(self):
        self.product['seo'] = {'title': 'Existuje', 'description': 'Existuje'}
        self.assertEqual((await self.writer.revise(self.raw, self.graphql))['status'], 'preserved')
        self.assertFalse(any(query == WRITE for query, _ in self.calls))

    async def test_concurrent_product_change_blocks_write(self):
        reads = 0
        async def changing(query, variables):
            nonlocal reads
            reads += 1
            if reads == 2:
                self.product['seo']['title'] = 'Merchant edit'
            return await self.graphql(query, variables)
        result = await self.writer.revise(self.raw, changing)
        self.assertEqual(result['reason'], 'CONCURRENT_PRODUCT_CHANGE')
        self.assertFalse(any(query == WRITE for query, _ in self.calls))

    async def test_lost_write_response_reconciles_without_second_write(self):
        async def lost(query, variables):
            result = await self.graphql(query, variables)
            if query == WRITE:
                raise httpx.ReadTimeout('timeout')
            return result
        result = await self.writer.revise(self.raw, lost)
        self.assertEqual(result['reason'], 'UNCERTAIN_REVISION_NO_RETRY')
        result = await SEORevisionWriter(self.audit).revise(self.raw, self.graphql)
        self.assertTrue(result['reconciled'])
        self.assertEqual(sum(query == WRITE for query, _ in self.calls), 1)

    async def test_unconfirmed_intent_cannot_blindly_retry(self):
        async def lost(query, variables):
            if query == WRITE:
                raise httpx.ReadTimeout('timeout')
            return await self.graphql(query, variables)
        await self.writer.revise(self.raw, lost)
        result = await self.writer.revise(self.raw, self.graphql)
        self.assertEqual(result['reason'], 'UNCERTAIN_REVISION_NO_RETRY')
        self.assertFalse(any(query == WRITE for query, _ in self.calls))

    async def test_changed_feed_product_or_draft_cannot_write(self):
        self.product['status'] = 'DRAFT'
        self.assertEqual((await self.writer.revise(self.raw, self.graphql))['status'], 'hold')
        self.assertFalse(any(query == WRITE for query, _ in self.calls))

    async def test_disabled_setting_makes_no_remote_calls(self):
        result = await SEORevisionWriter(self.audit, env={'PILOT_SEO_AUTOPUBLISH': 'false'}).cycle([self.raw])
        self.assertEqual(result['status'], 'disabled')

    async def test_cycle_uses_existing_token_and_rotates_scan_cursor(self):
        import json
        variants = []
        def handle(request):
            self.assertEqual(request.headers['x-shopify-access-token'], 'existing')
            data = json.loads(request.content)
            variants.append(data['variables']['id'])
            return httpx.Response(200, json={'data': {'productVariant': {'product': self.product}}})
        self.product['seo'] = {'title': 'Existing', 'description': 'Existing'}
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            writer = SEORevisionWriter(self.audit, env={'SHOPIFY_STORE_DOMAIN': 'homestro.myshopify.com',
                'SHOPIFY_ACCESS_TOKEN': 'existing'}, client=client)
            products = [self.raw, {**self.raw, 'id': 'gid://shopify/ProductVariant/124'}]
            await writer.cycle(products, limit=1)
            await writer.cycle(products, limit=1)
        self.assertEqual(variants, ['gid://shopify/ProductVariant/123', 'gid://shopify/ProductVariant/124'])
