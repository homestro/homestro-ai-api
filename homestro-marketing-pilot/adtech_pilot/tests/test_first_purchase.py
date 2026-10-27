import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs

import httpx
from adtech_pilot.first_purchase import FirstPurchaseController, FirstPurchaseStore
from adtech_pilot.media_buyer import MetaPublisher, PlanAuditStore
from adtech_pilot.purchase_guard import PurchaseWatchdog

NOW = datetime.now(UTC).replace(microsecond=0)
CAMPAIGN, ADSET, AD, CREATIVE = '98765', '23456', '34567', '45678'
ENV = {'META_AD_ACCOUNT_ID': 'act_12345', 'META_ACCESS_TOKEN': 'test-secret', 'META_PIXEL_ID': '56789',
       'META_PAGE_ID': '67890', 'PILOT_LAUNCH_POLICY': 'first_purchase_acquisition_test',
       'PILOT_FIRST_PURCHASE_CAMPAIGN_ID': CAMPAIGN, 'PILOT_FIRST_PURCHASE_TEST_AUTHORIZED': 'true',
       'PILOT_FIRST_PURCHASE_ACTIVATION_ENABLED': 'true', 'ALLOW_MICRO_BUDGET': 'true',
       'DRY_RUN': 'false', 'PILOT_AD_DRY_RUN': 'false', 'PILOT_AD_MAX_BUDGET_EUR': '5'}


class FirstPurchaseTests(unittest.IsolatedAsyncioTestCase):
    async def fixture(self, directory, *, spend='0', today='0', approved=True, source_blockers=None, lost=False, cards=None, cap_rejected=False):
        audit = PlanAuditStore(Path(directory) / 'audit.sqlite')
        await audit.claim_meta_micro_campaign('act_12345', 'all')
        await audit.update_meta_micro_campaign(status='ACTIVE_PENDING_REVIEW', campaign_id=CAMPAIGN)
        if approved:
            await audit.record('meta_micro_campaign_partial', {'campaign_id': CAMPAIGN, 'adset_id': ADSET,
                'ad_id': AD, 'adcreative_id': CREATIVE})
        state = {'status': 'PAUSED', 'cap': '3500', 'spend': spend, 'today': today, 'writes': [], 'lost': lost}
        def handle(request):
            path = request.url.path
            if request.method == 'POST':
                body = parse_qs(request.content.decode())
                state['writes'].append((path, body))
                if 'spend_cap' in body and cap_rejected:
                    return httpx.Response(400, json={'error': {'code': 100, 'error_subcode': 1234, 'message': 'test provider cap minimum'}})
                if path.endswith('/' + CAMPAIGN):
                    if 'status' in body:
                        state['status'] = body['status'][0]
                        if body['status'][0] == 'ACTIVE' and state['lost']:
                            state['lost'] = False
                            raise httpx.ReadTimeout('lost response', request=request)
                    if 'spend_cap' in body:
                        state['cap'] = body['spend_cap'][0]
                return httpx.Response(200, json={'success': True})
            if path.endswith('/insights'):
                period = request.url.params.get('date_preset')
                return httpx.Response(200, json={'data': [{'campaign_id': CAMPAIGN, 'account_currency': 'EUR',
                    'spend': state['today'] if period == 'today' else state['spend']}]})
            if path.endswith('/act_12345'):
                return httpx.Response(200, json={'id': 'act_12345', 'timezone_name': 'Europe/Berlin'})
            if path.endswith('/adsets'):
                return httpx.Response(200, json={'data': [{'id': ADSET, 'status': 'ACTIVE', 'daily_budget': '500',
                    'start_time': (NOW-timedelta(days=1)).isoformat(), 'end_time': (NOW+timedelta(days=6)).isoformat(),
                    'targeting': {'geo_locations': {'countries': ['DE', 'AT']}},
                    'promoted_object': {'pixel_id': '56789', 'custom_event_type': 'PURCHASE'}, 'optimization_goal': 'OFFSITE_CONVERSIONS'}]})
            if path.endswith('/ads'):
                return httpx.Response(200, json={'data': [{'id': AD, 'status': 'ACTIVE',
                    'effective_status': 'CAMPAIGN_PAUSED', 'creative': {'id': CREATIVE}}]})
            if path.endswith('/previews'):
                return httpx.Response(200, json={'data': [{'body': '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=example"></iframe>'}]})
            if path.endswith('/' + CREATIVE):
                return httpx.Response(200, json={'id': CREATIVE, 'object_story_spec': {'page_id': '67890',
                    'link_data': {'message': 'Produktdetails bei Homestro', 'link': 'https://homestro.de/products/box', 'picture': 'https://cdn.shopify.com/box.jpg', 'name': 'Box', **({'child_attachments': cards} if cards else {})}}})
            if path.endswith('/' + AD):
                return httpx.Response(200, json={'id': AD, 'status': 'ACTIVE', 'effective_status': 'ACTIVE', 'creative': {'id': CREATIVE}})
            return httpx.Response(200, json={'id': CAMPAIGN, 'account_id': '12345', 'objective': 'OUTCOME_SALES',
                'status': state['status'], 'effective_status': state['status'], 'updated_time': NOW.isoformat(), 'spend_cap': state['cap']})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        control = FirstPurchaseController(audit, env=ENV, client=client)
        control.sources = AsyncMock(return_value=source_blockers or [])
        return audit, state, client, control

    def patches(self):
        return (patch.object(MetaPublisher, 'check_readiness', new=AsyncMock(return_value={'status': 'checked', 'account': {
            'account_status': 'active', 'currency': 'EUR', 'billing_ready': True, 'pixel_access_verified': True}})),
            patch('adtech_pilot.performance_loader.load_meta_performance', new=AsyncMock(return_value={'status': 'collected', 'metrics': []})))

    async def test_zero_previous_orders_activate_only_existing_owned_approved_ad_and_consent_starts_on_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, state, client, control = await self.fixture(directory)
            control.env = {**ENV, 'SHOPIFY_WEBHOOK_SECRET': 'test', 'PILOT_ADMIN_KEY': 'test-signature-secret'}
            before = control.store.authorize(CAMPAIGN, NOW-timedelta(days=4))
            self.assertIsNone(before['activated_at'])
            with self.patches()[0], self.patches()[1]:
                result = await control.cycle(now=NOW)
            await client.aclose()
            self.assertEqual(result['status'], 'active_confirmed')
            self.assertTrue(result['activation_performed'])
            self.assertFalse(result['prior_purchase_required'])
            self.assertEqual(result['consent']['activated_at'], NOW.isoformat())
            self.assertEqual(result['consent']['expires_at'], (NOW+timedelta(days=6)).isoformat())
            self.assertEqual(state['writes'], [('/v26.0/'+CAMPAIGN, {'spend_cap': ['500']}), ('/v26.0/'+CAMPAIGN, {'status': ['ACTIVE']})])
            self.assertEqual(result['native_spend_cap_readback_cents'], 500)
            self.assertIn('meta_preview_url', result['creative_preview'])
            self.assertEqual(FirstPurchaseStore(PlanAuditStore(Path(directory)/'audit.sqlite')).read()['activated_at'], NOW.isoformat())

    async def test_unseen_creative_returns_actual_preview_copy_and_never_activates(self):
        with tempfile.TemporaryDirectory() as directory:
            _, state, client, control = await self.fixture(directory, approved=False)
            control.env = {**ENV, 'SHOPIFY_WEBHOOK_SECRET': 'test', 'PILOT_ADMIN_KEY': 'test-signature-secret'}
            with self.patches()[0], self.patches()[1]:
                result = await control.cycle(now=NOW)
            await client.aclose()
            self.assertIn('EXACT_CREATIVE_PREVIEW_REVIEW_REQUIRED', result['blockers'])
            self.assertEqual(result['creative_preview']['message'], 'Produktdetails bei Homestro')
            self.assertEqual(result['creative_preview']['cards'][0]['destination'], 'https://homestro.de/products/box')
            self.assertFalse(any(body.get('status') == ['ACTIVE'] for _, body in state['writes']))

    async def test_prior_approval_never_overrides_owner_exclusions_or_duplicate_variant_cards(self):
        from adtech_pilot.website_ads import OWNER_EXCLUDED_HANDLES

        for cards, blocker in [
            ([{'link': 'https://homestro.de/products/'+next(iter(OWNER_EXCLUDED_HANDLES)), 'name': 'Bürste'}], 'OWNER_EXCLUDED_CREATIVE_PRODUCT'),
            ([{'link': 'https://homestro.de/products/box?variant=1'}, {'link': 'https://homestro.de/products/box?variant=2'}], 'DUPLICATE_PRODUCT_CARDS'),
            ([{'link': 'https://homestro.de/products/silicone-spatula', 'name': 'Silikonspachtel'}], 'OWNER_EXCLUDED_CREATIVE_PRODUCT'),
        ]:
            with tempfile.TemporaryDirectory() as directory:
                _, state, client, control = await self.fixture(directory, cards=cards)
                control.env = {**ENV, 'SHOPIFY_WEBHOOK_SECRET': 'test', 'PILOT_ADMIN_KEY': 'test-signature-secret'}
                with self.patches()[0], self.patches()[1]:
                    result = await control.cycle(now=NOW)
                await client.aclose()
                self.assertTrue(result['creative_review_passed'])
                self.assertIn(blocker, result['blockers'])
                self.assertFalse(any(body.get('status') == ['ACTIVE'] for _, body in state['writes']))

    async def test_native_cap_prepared_while_paused_without_starting_window_or_approving_unseen_creative(self):
        with tempfile.TemporaryDirectory() as directory:
            _, state, client, control = await self.fixture(directory, approved=False, spend='2.98')
            with self.patches()[0], self.patches()[1]:
                result = await control.cycle(now=NOW)
            await client.aclose()
            self.assertEqual(state['cap'], '798')
            self.assertEqual(result['native_spend_cap_readback_cents'], 798)
            self.assertIsNone(result['consent']['activation_intent_at'])
            self.assertIsNone(result['consent']['activated_at'])
            self.assertIn('EXACT_CREATIVE_PREVIEW_REVIEW_REQUIRED', result['blockers'])
            self.assertFalse(any(body.get('status') == ['ACTIVE'] for _, body in state['writes']))

    async def test_provider_native_cap_rejection_stays_paused_before_activation_and_exposes_safe_code(self):
        with tempfile.TemporaryDirectory() as directory:
            _, state, client, control = await self.fixture(directory, cap_rejected=True)
            with self.patches()[0], self.patches()[1]:
                result = await control.cycle(now=NOW)
            await client.aclose()
            self.assertEqual(result['status'], 'paused_confirmed')
            self.assertEqual(result['stage'], 'paused_native_cap_preparation')
            self.assertEqual(result['code'], 100)
            self.assertEqual(state['status'], 'PAUSED')
            self.assertFalse(any(body.get('status') == ['ACTIVE'] for _, body in state['writes']))

    async def test_total_cap_and_expiry_are_durable_and_cannot_be_reset_by_restart_or_new_campaign(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, state, client, control = await self.fixture(directory, spend='35')
            result = await control.cycle(now=NOW)
            self.assertEqual(result['reason'], 'TEST_TOTAL_CAP_REACHED')
            state['spend'] = '0'
            restarted = FirstPurchaseController(PlanAuditStore(Path(directory)/'audit.sqlite'), env=ENV, client=client)
            self.assertEqual((await restarted.cycle(now=NOW))['reason'], 'TEST_TOTAL_CAP_REACHED')
            with self.assertRaisesRegex(ValueError, 'CONSENT_SCOPE'):
                restarted.store.authorize('11111', NOW)
            await client.aclose()
        with tempfile.TemporaryDirectory() as directory:
            _, state, client, control = await self.fixture(directory)
            control.store.authorize(CAMPAIGN, NOW-timedelta(days=8))
            control.store.intent(NOW-timedelta(days=8), NOW-timedelta(days=1))
            self.assertEqual((await control.cycle(now=NOW))['reason'], 'TEST_EXPIRED')
            self.assertTrue(all(body == {'status': ['PAUSED']} for _, body in state['writes']))
            await client.aclose()

    async def test_daily_cap_and_emergency_stop_pause_without_spending_or_scope_changes(self):
        for changes, expected in [({'today': '5'}, 'DAILY_CAP_REACHED'), ({}, 'OWNER_EMERGENCY_STOP')]:
            with tempfile.TemporaryDirectory() as directory:
                _, state, client, control = await self.fixture(directory, **changes)
                if not changes:
                    control.env = {**ENV, 'PILOT_EMERGENCY_STOP': 'true'}
                result = await control.cycle(now=NOW)
                self.assertEqual(result['reason'], expected)
                self.assertEqual(state['writes'], [('/v26.0/'+CAMPAIGN, {'status': ['PAUSED']})])
                await client.aclose()

    async def test_watchdog_first_purchase_mode_does_not_call_purchase_evidence_and_preserves_default(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = PlanAuditStore(Path(directory)/'audit.sqlite')
            evidence = AsyncMock()
            with patch.object(FirstPurchaseController, 'cycle', new=AsyncMock(return_value={'status': 'blocked', 'reason': 'technical_gate'})):
                result = await PurchaseWatchdog(audit, env={'PILOT_LAUNCH_POLICY': 'first_purchase_acquisition_test'}, evidence=evidence).cycle()
            evidence.check.assert_not_awaited()
            self.assertEqual(result['reason'], 'technical_gate')

    async def test_actual_source_checks_require_current_stock_signed_attribution_pixel_and_real_checkout_not_a_purchase(self):
        from adtech_pilot.order_economics import tracking_ref

        secret = 'test-existing-signature-secret'
        token = tracking_ref(CAMPAIGN, AD, 'a'*24, secret=secret, expires_at=NOW+timedelta(days=1), issued_at=NOW)
        card = {'link': 'https://homestro.de/products/box?variant=123456&pilot_ref='+token, 'picture': 'https://cdn.shopify.com/box.jpg'}
        feed = [{'id': '123456', 'title': 'Box', 'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
                 'link': 'https://homestro.de/products/box?variant=123456', 'image_link': card['picture']}]
        state = {'pixel': True, 'stock': True, 'checkout': True, 'requests': []}
        def handle(request):
            state['requests'].append(request.method)
            if request.url.path == '/feed':
                return httpx.Response(200, json=[{**feed[0], 'availability': 'in_stock' if state['stock'] else 'out_of_stock'}])
            if request.url.path == '/api/marketing/v2/tracking/site-check':
                return httpx.Response(200, json={'configured': True, 'expectedPixelId': '56789', 'pixelBeaconsSuppressed': True, 'purchaseEventDelivered': False, 'observedPixelIds': ['56789']})
            if request.url.path.startswith('/cart/c/'):
                return httpx.Response(302, headers={'location': state.get('redirect', 'https://shop.app/checkout/test-anonymous')})
            if request.url.host == 'shop.app':
                return httpx.Response(302, headers={'location': 'https://homestro.de/checkouts/cn/test-anonymous'})
            if request.url.path.startswith('/cart/'):
                return httpx.Response(302, headers={'location': '/cart/c/test-anonymous'})
            if request.url.path.startswith('/checkouts/'):
                return httpx.Response(200 if state['checkout'] else 503, text='<html>Shopify checkout</html>')
            return httpx.Response(200, text='<form action="/cart/add">Buy</form>'+('56789' if state['pixel'] else '\\"pixel_id\\":\\"99887\\"'))
        with tempfile.TemporaryDirectory() as directory:
            controller = FirstPurchaseController(PlanAuditStore(Path(directory)/'audit.sqlite'), env={
                **ENV, 'HOMESTRO_PRODUCT_FEED_URL': 'https://homestro.de/feed', 'PILOT_ADMIN_KEY': secret})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                self.assertEqual(await controller.sources(client, [card], CAMPAIGN, AD, '56789', NOW), [])
                for flag, reason in [('pixel', 'STOREFRONT_PIXEL_ID_MISMATCH'),
                                     ('stock', 'CREATIVE_SOURCE_NOT_CURRENT_IN_STOCK'),
                                     ('checkout', 'REAL_CHECKOUT_PAGE_NOT_AVAILABLE')]:
                    state[flag] = False
                    self.assertIn(reason, await controller.sources(client, [card], CAMPAIGN, AD, '56789', NOW))
                    state[flag] = True
                self.assertIn('SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED', await controller.sources(
                    client, [{**card, 'link': 'https://homestro.de/products/box'}], CAMPAIGN, AD, '56789', NOW))
                for destination in ['https://shop.app/products/not-checkout', 'https://evil.example/checkout/test', 'https://homestro.de:444/checkouts/test']:
                    state['redirect'] = destination
                    self.assertIn('REAL_CHECKOUT_REDIRECT_NOT_VERIFIED', await controller.sources(client, [card], CAMPAIGN, AD, '56789', NOW))
                    self.assertEqual(controller.site_diagnostics[0]['checkout_rejected_redirect']['reason'], 'UNTRUSTED_CHECKOUT_REDIRECT')
                state.pop('redirect')
            self.assertEqual(set(state['requests']), {'GET'})
            state['pixel'] = False
            controller.env = {**controller.env, 'PILOT_ORGANIC_API_KEY': 'test-internal'}
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                self.assertEqual(await controller.sources(client, [card], CAMPAIGN, AD, '56789', NOW), [])

    async def test_lost_activation_response_is_compensated_and_never_extends_consent_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            _, state, client, control = await self.fixture(directory, lost=True)
            control.env = {**ENV, 'SHOPIFY_WEBHOOK_SECRET': 'test', 'PILOT_ADMIN_KEY': 'test-signature-secret'}
            with self.patches()[0], self.patches()[1]:
                result = await control.cycle(now=NOW)
            self.assertEqual(result['status'], 'paused_confirmed')
            self.assertEqual(state['status'], 'PAUSED')
            held = control.store.read()
            self.assertEqual(held['state'], 'activation_intent')
            self.assertIsNone(held['activated_at'])
            deadline = held['expires_at']
            control.store.intent(NOW+timedelta(hours=2), NOW+timedelta(days=7))
            self.assertEqual(control.store.read()['expires_at'], deadline)
            await client.aclose()

    async def test_native_day_envelope_is_persistent_cannot_increase_intraday_and_never_exceeds_total(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FirstPurchaseStore(PlanAuditStore(Path(directory)/'audit.sqlite'))
            first = store.envelope('2.98', '0', NOW)
            self.assertEqual(first['cap_cents'], 798)
            store.confirm_envelope(first['day'], 798)
            # A changed late report cannot replenish spend in the same day.
            same = store.envelope('4.98', '0', NOW)
            self.assertEqual(same['cap_cents'], 798)
            restarted = FirstPurchaseStore(PlanAuditStore(Path(directory)/'audit.sqlite'))
            tomorrow = restarted.envelope('7.98', '0', NOW+timedelta(days=1))
            self.assertEqual(tomorrow['cap_cents'], 1298)
            self.assertTrue(restarted.previous_envelope_confirmed(798, tomorrow['day']))
            self.assertFalse(restarted.previous_envelope_confirmed(700, tomorrow['day']))
            self.assertEqual(restarted.envelope('33', '0', NOW+timedelta(days=2))['cap_cents'], 3500)
            with self.assertRaises(ValueError):
                restarted.envelope('0', '2', NOW)
