import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("PILOT_ADMIN_KEY", "test-admin-key-with-at-least-32-characters")
os.environ.setdefault("PILOT_AUDIT_DB_PATH", tempfile.mktemp(suffix=".sqlite3"))

import httpx
from adtech_pilot.main_pilot import create_app


class MainPilotTests(unittest.TestCase):
    def setUp(self):
        self.db = tempfile.mktemp(suffix=".sqlite3")
        os.environ["PILOT_AD_DRY_RUN"] = "true"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "0"
        os.environ["PILOT_AUDIT_DB_PATH"] = self.db
        self.app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

    def request(self, method, path, **kwargs):
        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app), base_url="http://test"
            ) as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(run())

    def test_attribution_link_and_readiness_require_admin_and_never_enable_spend(self):
        from unittest.mock import patch
        headers = {'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'}
        for path in ('/pilot/attribution', '/pilot/search/readiness', '/pilot/daily-report'):
            self.assertEqual(self.request('GET', path).status_code, 401)
        with patch.dict(os.environ, {'GOOGLE_ADS_CUSTOMER_ID': '', 'MICROSOFT_ADS_ACCOUNT_ID': ''}):
            result = self.request('GET', '/pilot/search/readiness', headers=headers).json()
        self.assertFalse(result['paid_activation_authorized'])
        self.assertIn('GOOGLE_ADS_CUSTOMER_ID', result['channels']['google']['missing_settings'])
        body = {'channel': 'google', 'campaign_id': '12345', 'content_id': '23456',
                'experiment': 'a' * 24, 'url': 'https://homestro.de/products/test?variant=123'}
        self.assertEqual(self.request('POST', '/pilot/attribution/link', json=body).status_code, 401)
        response = self.request('POST', '/pilot/attribution/link', json=body, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn('utm_source=google', response.json()['url'])
        self.assertIn('variant=123', response.json()['url'])
        self.assertEqual(response.json()['authorized_spend_eur'], 0)
        for url in ('https://evil.example/products/test', 'https://user@homestro.de/products/test', 'https://homestro.de:444/products/test'):
            self.assertEqual(self.request('POST', '/pilot/attribution/link', json={**body, 'url': url}, headers=headers).status_code, 422)

    def test_search_pause_is_admin_only_and_cannot_write_unobserved_campaign(self):
        from unittest.mock import AsyncMock, patch
        body = {'expected_account': '1234567890'}
        path = '/pilot/search/google/123/pause'
        self.assertEqual(self.request('POST', path, json=body).status_code, 401)
        with patch('adtech_pilot.search_channels.read_google', new=AsyncMock(return_value={'status': 'not_configured'})), patch('adtech_pilot.channel_control.pause_search_campaign', new=AsyncMock()) as writer:
            result = self.request('POST', path, json=body, headers={'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'})
        self.assertEqual(result.json()['reason'], 'CAMPAIGN_ACCOUNT_IDENTITY_NOT_OBSERVED')
        writer.assert_not_awaited()

    def test_search_creation_and_reporting_routes_require_current_review_and_admin(self):
        headers = {'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'}
        body = {'expected_revision': 'a' * 64, 'german_copy_reviewed': True}
        for channel in ('google', 'microsoft'):
            path = '/pilot/search/drafts/missing/create-' + channel + '-paused'
            self.assertEqual(self.request('POST', path, json=body).status_code, 401)
            self.assertEqual(self.request('POST', path, json=body, headers=headers).status_code, 409)
        self.assertEqual(self.request('GET', '/pilot/search/microsoft/performance').status_code, 401)
        from unittest.mock import patch
        with patch.dict(os.environ, {'MICROSOFT_ADS_ACCOUNT_ID': ''}):
            result = self.request('GET', '/pilot/search/microsoft/performance', headers=headers)
        self.assertEqual(result.json()['status'], 'not_configured')
        self.assertFalse(result.json()['writes_performed'])

    def test_admin_key_required_for_feed_and_metrics(self):
        response = self.request(
            "POST",
            "/feed/validate",
            content=b"[]",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 401)

    def test_brand_memory_requires_admin_review_and_current_revision(self):
        path = '/pilot/brand-memory'
        headers = {'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'}
        self.assertEqual(self.request('GET', path).status_code, 401)
        empty = self.request('GET', path, headers=headers).json()
        body = {'expected_revision': empty['revision'], 'entries': [{'id': 'voice', 'kind': 'voice',
            'text_de': 'Klar und sachlich formulieren.', 'source_url': 'https://homestro.de/', 'reviewed': True}]}
        self.assertEqual(self.request('PUT', path, json=body).status_code, 401)
        self.assertEqual(self.request('PUT', path, json=body, headers=headers).status_code, 200)
        self.assertEqual(self.request('PUT', path, json=body, headers=headers).status_code, 409)

    def test_public_payment_route_fails_closed_before_signing_configuration(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {"SHOPIFY_WEBHOOK_SECRET": ""}):
            response = self.request("POST", "/webhooks/shopify/orders-paid", content=b"{}")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(self.request("GET", "/webhooks/shopify/setup").json()["signing_configured"], False)
        self.assertEqual(self.request("POST", "/webhooks/shopify/unknown", content=b"{}").status_code, 404)
        self.assertEqual(self.request("POST", "/webhooks/shopify/orders-paid", content=b"x" * 1_048_577).status_code, 413)

    def test_brain_status_is_protected_and_does_not_enable_spend(self):
        self.assertEqual(self.request("GET", "/pilot/brain").status_code, 401)
        response = self.request("GET", "/pilot/brain", headers={
            "X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["budget_increase_authorized"])
        self.assertFalse(response.json()["full_autonomous_profit_optimization_verified"])

    def test_marketing_and_media_reports_require_admin_and_cannot_claim_publication(self):
        for path in ('/pilot/marketing', '/pilot/media', '/pilot/search/drafts'):
            self.assertEqual(self.request('GET', path).status_code, 401)
            response = self.request('GET', path, headers={
                'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'})
            self.assertEqual(response.status_code, 200)
        self.assertFalse(self.request('GET', '/pilot/marketing', headers={
            'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'}).json()['publication_performed_by_this_endpoint'])

    def test_search_validation_and_template_endpoints_require_admin_and_current_draft(self):
        for method, path in (("POST", "/pilot/search/drafts/missing/validate-google"), ("GET", "/pilot/search/drafts/missing/request-template")):
            self.assertEqual(self.request(method, path).status_code, 401)
            self.assertEqual(self.request(method, path, headers={"X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters"}).status_code, 404)

    def test_email_authority_and_non_mutating_unsubscribe_get(self):
        from adtech_pilot.email_delivery import EmailDelivery
        from adtech_pilot.media_buyer import PlanAuditStore

        headers = {'X-Pilot-Admin-Key': 'test-admin-key-with-at-least-32-characters'}
        payload = {'recipient': 'customer@example.test', 'subject': 'Produktdetails', 'body': 'Details ansehen',
                   'campaign_id': 'reviewed-1', 'owner_authorized': True}
        self.assertEqual(self.request('POST', '/pilot/email/send', json=payload).status_code, 401)
        from unittest.mock import patch
        with patch.dict(os.environ, {'PILOT_EMAIL_SEND_ENABLED': 'false'}):
            result = self.request('POST', '/pilot/email/send', json=payload, headers=headers)
            self.assertEqual(result.json()['status'], 'blocked')
        email = EmailDelivery(PlanAuditStore(Path(self.db)), secret='test-admin-key-with-at-least-32-characters')
        key = email.recipient_key('customer@example.test')
        url = '/email/unsubscribe/' + key + '/' + email.signature(key)
        self.assertEqual(self.request('GET', url).status_code, 200)
        with email.audit._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM pilot_email_consent').fetchone()[0], 0)
        self.assertEqual(self.request('POST', url).json()['status'], 'unsubscribed')
        self.assertEqual(self.request('POST', '/email/unsubscribe/' + key + '/forged').status_code, 404)

    def test_order_expense_api_requires_admin_actual_cost_confirmation_and_known_order(self):
        payload = {"order_hash": "a" * 64, "fulfillment_eur": "4.00", "payment_fees_eur": "1.00",
                   "returns_cost_eur": "0", "other_cost_eur": "0", "actual_costs_confirmed": True}
        self.assertEqual(self.request("GET", "/pilot/economics/orders").status_code, 401)
        self.assertEqual(self.request("POST", "/pilot/economics/expenses", json=payload).status_code, 401)
        headers = {"X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters"}
        self.assertEqual(self.request("POST", "/pilot/economics/expenses", headers=headers,
                                      json={**payload, "actual_costs_confirmed": False}).status_code, 422)
        self.assertEqual(self.request("POST", "/pilot/economics/expenses", headers=headers,
                                      json={**payload, "fulfillment_eur": "-1"}).status_code, 422)
        self.assertEqual(self.request("POST", "/pilot/economics/expenses", headers=headers,
                                      json=payload).status_code, 404)

    def test_trigger_requires_exact_secret_and_does_not_accept_admin_header(self):
        self.assertEqual(self.request("POST", "/trigger").status_code, 401)
        self.assertEqual(self.request("POST", "/trigger", headers={"X-Pilot-Token": "wrong"}).status_code, 401)
        self.assertEqual(self.request("POST", "/trigger", headers={
            "X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters"}).status_code, 401)
        result = self.request("POST", "/trigger", headers={
            "X-Pilot-Token": "test-admin-key-with-at-least-32-characters"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["status"], "no_managed_campaign")

    def test_feed_validation_and_preparation_routes_do_not_publish(self):
        feed = {
            "products": [
                {
                    "id": "sku",
                    "title": "Napf",
                    "description": "Napf aus Edelstahl",
                    "link": "https://homestro.de/products/napf",
                    "image_link": "https://cdn.shopify.com/napf.jpg",
                    "price": "19.90 EUR",
                    "availability": "in_stock",
                    "brand": "Homestro",
                    "mpn": "sku",
                }
            ]
        }
        headers = {
            "X-Pilot-Admin-Key": "test-admin-key-with-at-least-32-characters",
            "Content-Type": "application/json",
        }
        response = self.request(
            "POST",
            "/feed/prepare/meta",
            content=json.dumps(feed).encode(),
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "prepared_not_uploaded")
        self.assertFalse(response.json()["platform_write_performed"])

    def test_health_exposes_zero_budget_and_dry_run(self):
        response = self.request("GET", "/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["dry_run"])
        self.assertEqual(response.json()["max_budget_limit_eur"], 0)
        self.assertFalse(response.json()["mutations_enabled"])

    def test_health_reads_explicit_live_controls_and_keeps_five_euro_cap(self):
        os.environ["DRY_RUN"] = "false"
        os.environ["MARKETING_BUDGET_LIMIT"] = "1000"
        os.environ["PILOT_AD_DRY_RUN"] = "false"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "1000"
        app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.get("/healthz")

        response = asyncio.run(run())
        self.assertFalse(response.json()["dry_run"])
        self.assertEqual(response.json()["max_budget_limit_eur"], 5.0)
        # No optimizer adapter is configured, so this does not claim a mutation.
        self.assertFalse(response.json()["mutations_enabled"])

    def test_either_kill_switch_keeps_optimizer_dry(self):
        os.environ["DRY_RUN"] = "false"
        os.environ["PILOT_AD_DRY_RUN"] = "true"
        os.environ["PILOT_AD_MAX_BUDGET_EUR"] = "5"
        app = create_app(admin_key="test-admin-key-with-at-least-32-characters")

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.get("/healthz")

        response = asyncio.run(run())
        self.assertTrue(response.json()["dry_run"])


if __name__ == "__main__":
    unittest.main()
