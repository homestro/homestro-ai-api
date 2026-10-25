import asyncio
import base64
import hashlib
import hmac
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from adtech_pilot.payment_webhooks import PaymentWebhookStore, receive_payment
from adtech_pilot.purchase_guard import PurchaseEvidence
from fastapi import HTTPException


class PaymentWebhooksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "payments.sqlite"
        self.env = {"SHOPIFY_WEBHOOK_SECRET": "merchant-admin-signing-secret",
                    "SHOPIFY_STORE_DOMAIN": "homestro.myshopify.com", "PILOT_PAYMENT_DB_PATH": str(self.path),
                    "PILOT_PURCHASE_SOURCE": "shopify_webhook"}
        self.now = datetime.now(UTC)
        self.payload = {"id": 12345, "test": False, "financial_status": "paid", "currency": "EUR",
                        "total_price": "39.90", "cancelled_at": None, "updated_at": self.now.isoformat(),
                        "shipping_address": {"country_code": "DE", "name": "PRIVATE CUSTOMER"},
                        "email": "private@example.com"}

    def send(self, payload=None, topic="orders/paid", route="orders-paid", now=None, signature=None, env=None):
        raw = json.dumps(self.payload if payload is None else payload).encode()
        headers = {"X-Shopify-Hmac-Sha256": signature or base64.b64encode(
            hmac.new(self.env["SHOPIFY_WEBHOOK_SECRET"].encode(), raw, hashlib.sha256).digest()).decode(),
            "X-Shopify-Shop-Domain": "homestro.myshopify.com", "X-Shopify-Topic": topic}
        return asyncio.run(receive_payment(raw=raw, headers=headers, route=route, env=env or self.env, now=now or self.now))

    def evidence(self, now=None):
        return asyncio.run(PurchaseEvidence(env=self.env).check(now=now or self.now))

    def test_signed_payment_is_durable_without_orders_api_and_without_customer_storage(self):
        result = self.send()
        self.assertTrue(result["purchase_evidence_added"])
        self.assertTrue(self.evidence()["verified"])
        self.assertTrue(PaymentWebhookStore(self.path).evidence(now=self.now)["verified"])
        with PaymentWebhookStore(self.path).connect() as db:
            dump = "\n".join(db.iterdump())
        self.assertNotIn("PRIVATE CUSTOMER", dump)
        self.assertNotIn("private@example.com", dump)
        self.assertNotIn(self.env["SHOPIFY_WEBHOOK_SECRET"], dump)

    def test_replayed_or_changed_delivery_cannot_extend_first_payment(self):
        self.send()
        self.assertTrue(self.send()["duplicate"])
        late = self.now + timedelta(minutes=14)
        self.assertFalse(self.send({**self.payload, "updated_at": late.isoformat()}, now=late)["purchase_evidence_added"])
        self.assertFalse(self.evidence(now=self.now + timedelta(minutes=16))["verified"])

    def test_refund_and_cancel_invalidate_and_late_paid_delivery_cannot_restore(self):
        for topic, route, payload in [("refunds/create", "refunds-created", {"id": 555, "order_id": 12345}),
                                      ("orders/cancelled", "orders-cancelled", {**self.payload, "cancelled_at": self.now.isoformat()})]:
            with self.subTest(topic=topic):
                self.send()
                self.send(payload, topic, route)
                self.assertFalse(self.evidence()["verified"])
                self.assertFalse(self.send({**self.payload, "total_price": "40.00"})["purchase_evidence_added"])

    def test_refund_arriving_before_payment_is_sticky(self):
        self.send({"id": 555, "order_id": 12345}, "refunds/create", "refunds-created")
        self.assertFalse(self.send()["purchase_evidence_added"])
        self.assertFalse(self.evidence()["verified"])

    def test_wrong_signature_topic_shop_and_unconfigured_secret_rejected(self):
        for kwargs, status in [({"signature": "invalid"}, 401),
                               ({"topic": "orders/cancelled"}, 400),
                               ({"env": {**self.env, "SHOPIFY_STORE_DOMAIN": "other.myshopify.com"}}, 401),
                               ({"env": {**self.env, "SHOPIFY_WEBHOOK_SECRET": ""}}, 503)]:
            with self.subTest(kwargs=kwargs), self.assertRaises(HTTPException) as error:
                self.send(**kwargs)
            self.assertEqual(error.exception.status_code, status)

    def test_test_samples_foreign_orders_zero_value_and_stale_events_never_unlock(self):
        values = [{"test": True}, {"id": 820982911946105508}, {"currency": "USD"}, {"total_price": "0"},
                  {"shipping_address": {"country_code": "US"}}, {"financial_status": "authorized"},
                  {"updated_at": (self.now - timedelta(minutes=16)).isoformat()},
                  {"updated_at": (self.now + timedelta(seconds=1)).isoformat()}]
        for changes in values:
            with self.subTest(changes=changes):
                self.send({**self.payload, **changes})
                self.assertFalse(self.evidence()["verified"])

    def test_ordinary_pending_order_update_does_not_prevent_later_payment(self):
        self.send({**self.payload, "financial_status": "pending"}, "orders/updated", "orders-updated")
        self.send()
        self.assertTrue(self.evidence()["verified"])
        self.send({**self.payload, "financial_status": "voided"}, "orders/updated", "orders-updated")
        self.assertFalse(self.evidence()["verified"])
