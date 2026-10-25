import unittest

import httpx
from adtech_pilot.store_diagnostics import MAX_HTML, audit_store, inspect_page

VALID = b'''<html><head><title>Produkt</title><meta name="description" content="Popis">
<link rel="canonical" href="/products/a"><script type="application/ld+json">
{"@graph":[{"@type":["Product"]}]}</script></head><body><h1>Produkt</h1>
<img src="a.jpg" alt="Produkt"></body></html>'''


class StoreDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def test_valid_product_has_no_invented_performance_claim(self):
        result = inspect_page(VALID, 'https://homestro.de/products/a')
        self.assertEqual(result['issues'], [])
        self.assertTrue(result['product_structured_data_present'])
        self.assertFalse(result['rankings_verified'])
        self.assertFalse(result['core_web_vitals_measured'])

    def test_native_shopify_product_group_is_recognized(self):
        result = inspect_page(VALID.replace(b'"Product"', b'"ProductGroup"'), 'https://homestro.de/products/a')
        self.assertTrue(result['product_structured_data_present'])
        self.assertEqual(result['issues'], [])

    def test_missing_metadata_and_noindex_are_actionable(self):
        result = inspect_page(b'<html><meta name="robots" content="noindex"><body><img></body></html>',
                              'https://homestro.de/products/a', status_code=404)
        codes = {issue['code'] for issue in result['issues']}
        self.assertTrue({'PAGE_NOINDEX', 'TITLE_MISSING', 'LANDING_HTTP_NOT_200',
                         'PRODUCT_STRUCTURED_DATA_NOT_FOUND'}.issubset(codes))

    def test_unapproved_and_oversized_pages_rejected(self):
        for body, url in ((VALID, 'https://external.example/'),
                          (b'x' * (MAX_HTML + 1), 'https://homestro.de/')):
            with self.assertRaises(ValueError):
                inspect_page(body, url)

    async def test_reads_at_most_four_own_pages_without_writes(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, content=VALID)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await audit_store([{'link': f'https://homestro.de/products/{i}'} for i in range(10)], client=client)
        self.assertEqual(result['sampled_pages'], 4)
        self.assertTrue(all(request.method == 'GET' for request in requests))
        self.assertFalse(result['mutations_performed'])

    async def test_external_redirect_is_never_requested(self):
        hosts = []
        def handle(request):
            hosts.append(request.url.host)
            return httpx.Response(302, headers={'location': 'https://external.example/'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await audit_store([], client=client)
        self.assertEqual(hosts, ['homestro.de'])
        self.assertEqual(result['pages'][0]['status'], 'unavailable')

    async def test_own_store_redirect_is_followed(self):
        def handle(request):
            if request.url.host == 'homestro.de':
                return httpx.Response(302, headers={'location': 'https://www.homestro.de/'})
            return httpx.Response(200, content=VALID)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await audit_store([], client=client)
        self.assertEqual(result['pages'][0]['url'], 'https://www.homestro.de/')
