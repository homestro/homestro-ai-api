import unittest

import httpx
from adtech_pilot.first_purchase import verify_checkout_redirects


class CheckoutRedirectTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, responses):
        requests = []

        def handle(request):
            requests.append(request)
            response = responses.get(str(request.url))
            if response is None:
                raise AssertionError('Unexpected checkout destination')
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await verify_checkout_redirects(client, '123456')
        self.assertTrue(all(request.method == 'GET' for request in requests))
        return result, requests

    async def test_canonical_host_and_intermediate_redirects_reach_real_checkout(self):
        result, requests = await self.check({
            'https://homestro.de/cart/123456:1': httpx.Response(302, headers={'location': 'https://www.homestro.de/cart/123456:1'}),
            'https://www.homestro.de/cart/123456:1': httpx.Response(303, headers={'location': '/checkouts/cn/session'}),
            'https://www.homestro.de/checkouts/cn/session': httpx.Response(307, headers={'location': '/checkouts/cn/session?step=contact'}),
            'https://www.homestro.de/checkouts/cn/session?step=contact': httpx.Response(200, text='<html>Shopify checkout</html>'),
        })
        self.assertIsNone(result)
        self.assertEqual(len(requests), 4)

    async def test_external_insecure_credential_and_port_redirects_are_never_requested(self):
        for target in ('https://foreign.example/checkouts/session', 'http://homestro.de/checkouts/session',
                       'https://user:password@homestro.de/checkouts/session',
                       'https://homestro.de:8443/checkouts/session'):
            with self.subTest(target=target):
                result, requests = await self.check({
                    'https://homestro.de/cart/123456:1': httpx.Response(302, headers={'location': target}),
                })
                self.assertEqual(result, 'REAL_CHECKOUT_REDIRECT_NOT_VERIFIED')
                self.assertEqual(len(requests), 1)

    async def test_loop_and_missing_location_fail_without_retries(self):
        for headers in ({}, {'location': '/cart/123456:1'}):
            result, requests = await self.check({
                'https://homestro.de/cart/123456:1': httpx.Response(302, headers=headers),
            })
            self.assertEqual(result, 'REAL_CHECKOUT_REDIRECT_NOT_VERIFIED')
            self.assertEqual(len(requests), 1)

    async def test_cart_page_and_error_checkout_do_not_pass(self):
        for target, status, body, expected in (
            ('/cart', 200, 'checkout', 'REAL_CHECKOUT_REDIRECT_NOT_VERIFIED'),
            ('/checkouts/cn/session', 503, 'checkout', 'REAL_CHECKOUT_PAGE_NOT_AVAILABLE'),
            ('/checkouts/cn/session', 200, 'maintenance', 'REAL_CHECKOUT_PAGE_NOT_AVAILABLE'),
        ):
            result, _ = await self.check({
                'https://homestro.de/cart/123456:1': httpx.Response(302, headers={'location': target}),
                'https://homestro.de' + target: httpx.Response(status, text=body),
            })
            self.assertEqual(result, expected)

    async def test_redirect_hop_limit_is_bounded(self):
        responses = {'https://homestro.de/cart/123456:1': httpx.Response(302, headers={'location': '/step/0'})}
        for index in range(6):
            responses['https://homestro.de/step/' + str(index)] = httpx.Response(
                302, headers={'location': '/step/' + str(index + 1)})
        result, requests = await self.check(responses)
        self.assertEqual(result, 'REAL_CHECKOUT_REDIRECT_NOT_VERIFIED')
        self.assertEqual(len(requests), 6)
