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
