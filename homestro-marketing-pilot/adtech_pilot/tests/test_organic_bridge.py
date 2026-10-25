import unittest
from datetime import UTC, datetime, timedelta

import httpx
from adtech_pilot.organic_bridge import read_organic_results


class OrganicBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def result(self, body, *, status=200):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(status, json=body)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await read_organic_results(client=client)
        self.assertTrue(all(request.method == 'GET' for request in requests))
        return result

    def payload(self):
        return {'generatedAt': datetime.now(UTC).isoformat(), 'publishedTotal': 12,
                'channels': [{'channel': 'instagram', 'published': 12}],
                'guides': [{'handle': 'guide', 'url': 'https://homestro.de/pages/guide'}]}

    async def test_reads_existing_receipts_without_claiming_platform_views(self):
        result = await self.result(self.payload())
        self.assertEqual(result['published_records_7d'], 12)
        self.assertFalse(result['platform_visibility_independently_verified'])
        self.assertEqual(len(result['published_guide_records']), 1)

    async def test_stale_and_invalid_counts_do_not_become_evidence(self):
        for body in ({**self.payload(), 'publishedTotal': True},
                     {**self.payload(), 'generatedAt': (datetime.now(UTC) - timedelta(hours=2)).isoformat()}):
            self.assertEqual((await self.result(body))['status'], 'unavailable')

    async def test_provider_error_is_local_to_bridge(self):
        self.assertEqual((await self.result({}, status=503))['status'], 'unavailable')

    async def test_external_guide_links_not_forwarded(self):
        body = self.payload()
        body['guides'] = [{'handle': 'evil', 'url': 'https://external.example/'}]
        self.assertEqual((await self.result(body))['published_guide_records'], [])


class CatalogBrainBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_credential_reads_only_counts_without_claiming_publication(self):
        from adtech_pilot.organic_bridge import read_catalog_brain
        body = {'generatedAt': datetime.now(UTC).isoformat(), 'enabled': True,
                'counts': [{'state': 'prepared', 'count': 20}, {'state': 'blocked', 'count': 4}]}
        def handle(request):
            self.assertEqual(request.method, 'GET')
            self.assertTrue(request.url.path.endswith('/catalog-brain'))
            self.assertEqual(request.headers['Authorization'], 'Bearer test-internal-key')
            self.assertNotIn('test-internal-key', str(request.url))
            return httpx.Response(200, json=body)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test-internal-key'}, client=client)
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['catalog_records'], 24)
        self.assertFalse(result['publication_confirmed'])
        self.assertFalse(result['writes_performed'])

    async def test_no_key_is_offline_and_stale_or_invalid_counts_are_not_evidence(self):
        from adtech_pilot.organic_bridge import read_catalog_brain
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network'))) as client:
            self.assertEqual((await read_catalog_brain(env={}, client=client))['status'], 'not_configured')
        for generated, counts in ((datetime.now(UTC)-timedelta(hours=1), []),
                                  (datetime.now(UTC), [{'state': 'prepared', 'count': True}])):
            def handle(_):
                return httpx.Response(200, json={'generatedAt': generated.isoformat(), 'enabled': True, 'counts': counts})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result = await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test'}, client=client)
            self.assertEqual(result['status'], 'unavailable')

    async def test_revision_bound_receipts_are_sanitized_and_unverified_counts_rejected(self):
        from adtech_pilot.organic_bridge import read_catalog_brain
        product = {'product_id': 'gid://shopify/Product/123', 'state': 'prepared',
            'decision': {'productId': 'gid://shopify/Product/123', 'revision': 'revision-2', 'eligible': True,
                'creativeBrief': {'sourceProductURL': 'https://homestro.de/products/box'}},
            'currentReceipts': [{'channel': 'facebook', 'status': 'published', 'count': 1}],
            'outcome': {'untrusted_secret': 'must-not-forward'}}
        body = {'generatedAt': datetime.now(UTC).isoformat(), 'enabled': True,
                'counts': [{'state': 'prepared', 'count': 1}], 'products': [product]}
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
            result = await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test'}, client=client)
        self.assertEqual(result['products'][0]['revision'], 'revision-2')
        self.assertFalse(result['products'][0]['publication_confirmed'])
        self.assertNotIn('must-not-forward', str(result))
        product['currentReceipts'][0]['count'] = True
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
            self.assertEqual((await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test'}, client=client))['status'], 'unavailable')


    async def test_pagination_reads_and_validates_receipts_beyond_first_hundred(self):
        from adtech_pilot.organic_bridge import read_catalog_brain
        rows = [{'product_id': f'gid://shopify/Product/{n}', 'decision': {
            'productId': f'gid://shopify/Product/{n}', 'revision': f'r-{n}', 'eligible': True,
            'creativeBrief': {'sourceProductURL': f'https://homestro.de/products/box-{n}'}},
            'state': 'prepared', 'currentReceipts': [{'channel': 'facebook', 'status': 'approved', 'count': 1}]} for n in range(1, 202)]
        cursors = []
        def handle(request):
            self.assertEqual(request.method, 'GET')
            after = request.url.params.get('after')
            cursors.append(after)
            offset = 0 if after is None else next(i+1 for i, row in enumerate(rows) if row['product_id'] == after)
            page = rows[offset:offset+100]
            return httpx.Response(200, json={'generatedAt': datetime.now(UTC).isoformat(), 'enabled': True,
                'counts': [{'state': 'prepared', 'count': 201}], 'products': page,
                'pageInfo': {'hasNextPage': offset+100 < len(rows), 'endCursor': page[-1]['product_id']}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test'}, client=client)
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(result['pages_read'], 3)
        self.assertEqual(result['source_records_read'], 201)
        self.assertTrue(result['coverage_complete'])
        self.assertEqual(result['products'][-1]['product_id'], 'gid://shopify/Product/201')
        self.assertEqual(result['products'][-1]['receipts'][0]['count'], 1)
        self.assertEqual(cursors, [None, 'gid://shopify/Product/100', 'gid://shopify/Product/200'])

    async def test_repeating_or_incomplete_pagination_never_claims_full_coverage(self):
        from adtech_pilot.organic_bridge import read_catalog_brain
        for mode in ('repeat', 'missing_rows'):
            requests = []
            def handle(request):
                requests.append(request)
                return httpx.Response(200, json={'generatedAt': datetime.now(UTC).isoformat(), 'enabled': True,
                    'counts': [{'state': 'prepared', 'count': 200}], 'products': [],
                    'pageInfo': {'hasNextPage': mode == 'repeat', 'endCursor': 'same'}})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                result = await read_catalog_brain(env={'PILOT_ORGANIC_API_KEY': 'test'}, client=client)
            self.assertEqual(result['status'], 'unavailable')
            self.assertLessEqual(len(requests), 2)
