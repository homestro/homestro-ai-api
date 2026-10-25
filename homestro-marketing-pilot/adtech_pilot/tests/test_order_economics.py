import asyncio
import base64
import hashlib
import hmac
import json
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from adtech_pilot.order_economics import (
    decode_ref,
    economics_summary,
    sync_unit_costs,
    tracked_story,
    tracked_url,
    tracking_ref,
)
from adtech_pilot.payment_webhooks import PaymentWebhookStore, receive_payment
from adtech_pilot.website_ads import website_story


class OrderEconomicsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = PaymentWebhookStore(Path(self.temp.name) / 'payments.sqlite')
        self.now = datetime.now(UTC)
        self.env = {'SHOPIFY_WEBHOOK_SECRET': 'signing-secret', 'PILOT_ADMIN_KEY': 'tracking-signing-key-0000000000000000',
                    'SHOPIFY_STORE_DOMAIN': 'test.myshopify.com', 'PILOT_PAYMENT_DB_PATH': str(self.store.path)}
        self.ref = tracking_ref('12345', '23456', 'a' * 24, secret=self.env['PILOT_ADMIN_KEY'],
                                expires_at=self.now + timedelta(days=6), issued_at=self.now - timedelta(hours=1))

    def payload(self):
        return {'id': 99887766, 'test': False, 'financial_status': 'paid', 'currency': 'EUR',
                'current_total_price': '39.90', 'current_total_tax': '0', 'updated_at': self.now.isoformat(),
                'shipping_address': {'country_code': 'DE', 'name': 'DO NOT STORE PERSON'},
                'email': 'private-person@example.com', 'line_items': [{'variant_id': 123, 'quantity': 2}],
                'landing_site': '/products/test?utm_campaign=12345&utm_content=23456&pilot_ref=' + self.ref}

    def send(self, topic, payload):
        raw = json.dumps(payload).encode()
        signature = base64.b64encode(hmac.new(b'signing-secret', raw, hashlib.sha256).digest()).decode()
        routes = {'orders/paid': 'orders-paid', 'refunds/create': 'refunds-created', 'orders/updated': 'orders-updated'}
        return asyncio.run(receive_payment(raw=raw, headers={'X-Shopify-Hmac-Sha256': signature,
            'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': 'test.myshopify.com'}, route=routes[topic], env=self.env, now=self.now))

    def test_channel_collision_cannot_credit_meta_or_double_count_order(self):
        ref = tracking_ref('12345', '23456', 'a' * 24, secret=self.env['PILOT_ADMIN_KEY'],
                           expires_at=self.now + timedelta(days=1), issued_at=self.now, channel='google')
        payload = self.payload()
        payload['landing_site'] = tracked_url('https://homestro.de/products/test?variant=123', ref,
                                              secret=self.env['PILOT_ADMIN_KEY'], at=self.now)
        self.send('orders/paid', payload)
        self.send('orders/paid', payload)
        self.assertEqual(economics_summary(self.store, '12345')['signed_url_tagged_paid_orders'], 0)
        self.assertEqual(economics_summary(self.store, '12345', None, channel='google')['signed_url_tagged_paid_orders'], 1)
        self.send('refunds/create', {'id': 54321, 'order_id': 99887766})
        self.assertEqual(economics_summary(self.store, '12345', None, channel='google')['refund_or_cancelled_orders'], 1)

    def test_channel_source_tampering_is_not_attributed(self):
        ref = tracking_ref('12345', '23456', 'a' * 24, secret=self.env['PILOT_ADMIN_KEY'],
                           expires_at=self.now + timedelta(days=1), issued_at=self.now, channel='microsoft')
        payload = self.payload()
        payload['landing_site'] = tracked_url('https://homestro.de/products/test', ref,
                                              secret=self.env['PILOT_ADMIN_KEY'], at=self.now).replace('utm_source=microsoft', 'utm_source=google')
        self.send('orders/paid', payload)
        self.assertEqual(economics_summary(self.store, '12345', None, channel='microsoft')['signed_url_tagged_paid_orders'], 0)

    def test_legacy_signature_and_database_migration_preserve_meta(self):
        import sqlite3

        from adtech_pilot.order_economics import initialize
        data = {'campaign': '12345', 'ad': '23456', 'experiment': 'a' * 24,
                'issued': self.now.isoformat(), 'expires': (self.now + timedelta(days=1)).isoformat()}
        body = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')
        signature = hmac.new(self.env['PILOT_ADMIN_KEY'].encode(), ('pilot-attribution-v1:' + body).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(decode_ref(body + '.' + signature, secret=self.env['PILOT_ADMIN_KEY'], at=self.now)['channel'], 'meta')
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE pilot_order_economics(order_hash TEXT PRIMARY KEY,campaign TEXT,ad TEXT,experiment TEXT,paid_at TEXT,net_revenue TEXT,cogs TEXT,blocked INTEGER)')
            db.execute("INSERT INTO pilot_order_economics VALUES('old','12345','23456','experiment','date','10','5',0)")
            initialize(db)
            initialize(db)
            self.assertEqual(db.execute('SELECT channel,net_revenue FROM pilot_order_economics').fetchone(), ('meta', '10'))

    def test_publisher_key_can_credit_only_organic_channels(self):
        self.env['PILOT_ORGANIC_API_KEY'] = 'o' * 40
        for index, channel in enumerate(('facebook', 'pinterest', 'google', 'meta')):
            ref = tracking_ref('12345', '23456', 'a' * 24, secret=self.env['PILOT_ORGANIC_API_KEY'],
                               expires_at=self.now + timedelta(days=1), issued_at=self.now, channel=channel)
            payload = self.payload()
            payload['id'] += index
            payload['landing_site'] = tracked_url('https://homestro.de/products/test', ref,
                                                  secret=self.env['PILOT_ORGANIC_API_KEY'], at=self.now)
            self.send('orders/paid', payload)
            count = economics_summary(self.store, '12345', None, channel=channel)['signed_url_tagged_paid_orders']
            self.assertEqual(count, 1 if channel in {'facebook', 'pinterest'} else 0)

    def test_signed_ref_rejects_tampering_expiry_and_wrong_key(self):
        self.assertEqual(decode_ref(self.ref, secret=self.env['PILOT_ADMIN_KEY'], at=self.now)['campaign'], '12345')
        for token, key, at in ((self.ref + '0', self.env['PILOT_ADMIN_KEY'], self.now),
                               (self.ref, 'wrong-key', self.now),
                               (self.ref, self.env['PILOT_ADMIN_KEY'], self.now + timedelta(days=8))):
            self.assertIsNone(decode_ref(token, secret=key, at=at))

    def test_webhook_attribution_cost_snapshot_dedup_and_no_pii(self):
        with closing(self.store.connect()) as db, db:
            db.execute('INSERT INTO pilot_unit_costs VALUES (?,?,?,?)', ('123', '5', 'EUR', (self.now - timedelta(minutes=1)).isoformat()))
        self.send('orders/paid', self.payload())
        self.send('orders/paid', self.payload())
        summary = economics_summary(self.store, '12345', 3)
        self.assertEqual(summary['signed_url_tagged_paid_orders'], 1)
        self.assertEqual(summary['missing_unit_cost_orders'], 0)
        self.assertIsNone(summary['contribution_after_ads_eur'])
        with closing(self.store.connect()) as db, db:
            order = db.execute('SELECT order_hash,cogs FROM pilot_order_economics').fetchone()
            self.assertEqual(order[1], '10')
            db.execute('INSERT INTO pilot_order_expenses VALUES (?,?,?,?,?,?)', (order[0], '4', '1', '0', '0', self.now.isoformat()))
            dump = '\n'.join(db.iterdump())
        summary = economics_summary(self.store, '12345', 3)
        self.assertAlmostEqual(summary['contribution_after_ads_eur'], 21.90)
        self.assertFalse(summary['causal_attribution_verified'])
        self.assertFalse(summary['scale_authorized'])
        for private in ('DO NOT STORE PERSON', 'private-person@example.com', 'signing-secret', 'tracking-signing-key'):
            self.assertNotIn(private, dump)
        self.assertIsNone(economics_summary(self.store, '12345', None)['contribution_after_ads_eur'])

    def test_missing_cost_and_refund_before_payment_never_become_profit(self):
        self.send('refunds/create', {'id': 54321, 'order_id': 99887766})
        self.send('orders/paid', self.payload())
        self.assertEqual(economics_summary(self.store, '12345')['signed_url_tagged_paid_orders'], 0)

    def test_monetary_edit_invalidates_but_nonfinancial_update_preserves_order(self):
        payload = self.payload()
        self.send('orders/paid', payload)
        self.send('orders/updated', {**payload, 'note': 'fulfillment changed'})
        self.assertEqual(economics_summary(self.store, '12345')['signed_url_tagged_paid_orders'], 1)
        self.send('orders/updated', {**payload, 'current_total_price': '29.90'})
        self.assertEqual(economics_summary(self.store, '12345')['signed_url_tagged_paid_orders'], 0)

    def test_refund_after_payment_invalidates_income(self):
        self.send('orders/paid', self.payload())
        self.send('refunds/create', {'id': 54321, 'order_id': 99887766})
        summary = economics_summary(self.store, '12345')
        self.assertEqual(summary['refund_or_cancelled_orders'], 1)
        self.assertIsNone(summary['contribution_after_ads_eur'])

    def test_unmarked_or_forged_landing_cannot_claim_paid_attribution(self):
        payload = self.payload()
        payload['landing_site'] = '/products/test?utm_campaign=12345'
        self.send('orders/paid', payload)
        self.assertEqual(economics_summary(self.store, '12345')['signed_url_tagged_paid_orders'], 0)

    def test_tracking_preserves_variant_and_all_carousel_destinations(self):
        products = [{'id': str(i), 'title': 'Produkt', 'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
                     'link': f'https://homestro.de/products/p-{i}?variant={i}',
                     'image_link': 'https://cdn.shopify.com/test.jpg'} for i in range(2)]
        story, _ = website_story(products, '4444')
        tagged = tracked_story(story, self.ref, '12345', '23456')
        self.assertNotIn('pilot_ref=', story['link_data']['link'])
        for item in [tagged['link_data'], *tagged['link_data']['child_attachments']]:
            self.assertIn('pilot_ref=', item['link'])
            self.assertIn('variant=', item['link'])
            self.assertEqual(item['link'], item['call_to_action']['value']['link'])

    def test_cost_sync_reuses_existing_app_flow_without_direct_token(self):
        async def run():
            paths = []
            def handler(request):
                paths.append(request.url.path)
                if request.url.path.endswith('/oauth/access_token'):
                    self.assertIn(b'grant_type=client_credentials', request.content)
                    return httpx.Response(200, json={'access_token': 'short-lived-test-token'})
                self.assertEqual(request.headers['X-Shopify-Access-Token'], 'short-lived-test-token')
                return httpx.Response(200, json={'data': {'productVariants': {'nodes': [],
                    'pageInfo': {'hasNextPage': False, 'endCursor': None}}}})
            env = {**self.env, 'SHOPIFY_CLIENT_ID': 'existing-app', 'SHOPIFY_CLIENT_SECRET': 'existing-secret'}
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await sync_unit_costs(self.store, env=env, client=client)
            self.assertEqual(result['status'], 'synchronized')
            self.assertEqual(len(paths), 2)
            self.assertNotIn('SHOPIFY_ACCESS_TOKEN', env)
        asyncio.run(run())

    def test_cost_sync_paginates_and_failed_snapshot_preserves_existing_data(self):
        async def run():
            calls = []
            def handler(request):
                variables = json.loads(request.content)['variables']
                calls.append(variables['after'])
                after = variables['after']
                return httpx.Response(200, json={'data': {'productVariants': {'nodes': [{
                    'id': 'gid://shopify/ProductVariant/' + ('123' if after is None else '124'),
                    'inventoryItem': {'unitCost': {'amount': '5.00', 'currencyCode': 'EUR'}}}],
                    'pageInfo': {'hasNextPage': after is None, 'endCursor': 'next' if after is None else 'last'}}}})
            env = {**self.env, 'SHOPIFY_ACCESS_TOKEN': 'existing-test-token'}
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await sync_unit_costs(self.store, env=env, client=client)
            self.assertEqual(result['unit_cost_variants'], 2)
            self.assertEqual(calls, [None, 'next'])
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={'errors': [{'message': 'denied'}]}))) as client:
                result = await sync_unit_costs(self.store, env=env, client=client)
            self.assertEqual(result['reason'], 'COST_QUERY_REJECTED')
            self.assertEqual(economics_summary(self.store, '12345')['unit_cost_variants'], 2)
        asyncio.run(run())
