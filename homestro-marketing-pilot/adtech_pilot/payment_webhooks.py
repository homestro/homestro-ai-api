"""Signed merchant-admin webhooks; durable payment evidence without Orders API.

The merchant-admin signing secret is NOT the app client secret. Payloads and
customer fields are never stored. Refund/cancel tombstones cannot be undone by
late/replayed payment messages. No webhook directly activates an advertisement.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping

from fastapi import HTTPException

TOPICS = {"orders-paid": "orders/paid", "orders-cancelled": "orders/cancelled",
          "refunds-created": "refunds/create", "orders-updated": "orders/updated"}
MAX_BODY = 1_048_576


def payment_database(env: Mapping[str, str]) -> Path:
    return Path(env.get("PILOT_PAYMENT_DB_PATH") or str(
        Path(env.get("PILOT_AUDIT_DB_PATH", "/data/adtech-pilot/audit.sqlite3")).with_name("payments.sqlite3")))


def date(value: Any) -> datetime:
    result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timezone required")
    return result.astimezone(UTC)


class PaymentWebhookStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS payment_deliveries (
                    body_hash TEXT PRIMARY KEY, topic TEXT NOT NULL, received_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS payment_evidence (
                    order_hash TEXT PRIMARY KEY, paid_at TEXT, blocked INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS payment_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            from .order_economics import initialize

            initialize(db)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def accept(self, *, topic: str, payload: dict[str, Any], body_hash: str,
               shop: str, now: datetime, env: Mapping[str, str] | None = None) -> dict[str, Any]:
        order_id = payload.get("order_id") if topic == "refunds/create" else payload.get("id")
        if not re.fullmatch(r"[1-9]\d{0,29}", str(order_id or "")):
            raise HTTPException(422, "ORDER_ID_REQUIRED")
        order_hash = hashlib.sha256(f"{shop}:{order_id}".encode()).hexdigest()
        paid_at = None
        added = False
        blocked = topic in {"orders/cancelled", "refunds/create"}
        if topic in {"orders/paid", "orders/updated"}:
            blocked = (payload.get("cancelled_at") is not None or
                       payload.get("financial_status") not in {"paid", "authorized", "pending", "partially_paid"})
            # Updates can revoke a payment, never create/refresh payment evidence.
            if topic == "orders/paid" and not blocked:
                try:
                    amount = Decimal(str(payload.get("current_total_price", payload.get("total_price", "0"))))
                    event_at = date(payload.get("updated_at"))
                    valid = (payload.get("test") is False and payload.get("financial_status") == "paid"
                             and payload.get("currency") == "EUR" and amount.is_finite() and amount > 0
                             and (payload.get("shipping_address") or {}).get("country_code") in {"DE", "AT"}
                             and now - timedelta(minutes=15) <= event_at <= now)
                    if valid:
                        paid_at = event_at.isoformat()
                except (ValueError, InvalidOperation, TypeError):
                    pass
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            inserted = db.execute("INSERT OR IGNORE INTO payment_deliveries VALUES (?,?,?)",
                                  (body_hash, topic, now.isoformat())).rowcount
            if not inserted:
                return {"accepted": True, "duplicate": True, "purchase_evidence_added": False}
            if blocked:
                db.execute("INSERT INTO payment_evidence(order_hash,blocked) VALUES (?,1) "
                           "ON CONFLICT(order_hash) DO UPDATE SET blocked=1", (order_hash,))
            elif paid_at:
                # A second body/header/event ID must not extend a purchase window.
                added = db.execute("INSERT OR IGNORE INTO payment_evidence(order_hash,paid_at) VALUES (?,?)",
                           (order_hash, paid_at)).rowcount == 1
            elif topic == "orders/updated" and payload.get("financial_status") != "paid":
                db.execute("UPDATE payment_evidence SET blocked=1 WHERE order_hash=?", (order_hash,))
            from .order_economics import record_paid_order

            record_paid_order(db, topic=topic, payload=payload, order_hash=order_hash,
                              blocked=blocked, env=env or {}, now=now)
            db.execute("INSERT INTO payment_state VALUES ('last_authenticated_delivery',?) "
                       "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (now.isoformat(),))
        return {"accepted": True, "duplicate": False, "purchase_evidence_added": added}

    def evidence(self, *, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(UTC)
        with closing(self.connect()) as db:
            count = db.execute("SELECT count(*) FROM payment_evidence WHERE blocked=0 AND paid_at>=? AND paid_at<=?",
                ((now - timedelta(minutes=15)).isoformat(), now.isoformat())).fetchone()[0]
            row = db.execute("SELECT value FROM payment_state WHERE key='last_authenticated_delivery'").fetchone()
        return {"verified": count > 0, "source": "shopify_signed_payment_webhook", "qualifying_orders": count,
                "attribution_verified": False, "window_minutes": 15, "checked_at": now.isoformat(),
                "last_authenticated_delivery": row[0] if row else None,
                "reason": "FRESH_PAID_DE_AT_ORDER" if count else "NO_FRESH_SIGNED_PAYMENT"}


async def receive_payment(*, raw: bytes, headers: Mapping[str, str], route: str,
                          env: Mapping[str, str] | None = None, now: datetime | None = None):
    env = os.environ if env is None else env
    secret = env.get("SHOPIFY_WEBHOOK_SECRET", "")
    if not secret:
        raise HTTPException(503, "SHOPIFY_ADMIN_WEBHOOK_SIGNING_SECRET_REQUIRED")
    if len(raw) > MAX_BODY:
        raise HTTPException(413, "WEBHOOK_TOO_LARGE")
    headers = {str(key).lower(): value for key, value in headers.items()}
    expected = base64.b64encode(hmac.new(secret.encode(), raw, hashlib.sha256).digest()).decode()
    provided = headers.get("x-shopify-hmac-sha256", "")
    if not provided.isascii() or not hmac.compare_digest(expected, provided):
        raise HTTPException(401, "INVALID_SHOPIFY_SIGNATURE")
    topic = TOPICS.get(route)
    if not topic or headers.get("x-shopify-topic") != topic:
        raise HTTPException(400, "WEBHOOK_TOPIC_MISMATCH")
    shop = env.get("SHOPIFY_STORE_DOMAIN", "").removeprefix("https://").rstrip("/").lower()
    if not shop or headers.get("x-shopify-shop-domain", "").lower() != shop:
        raise HTTPException(401, "WEBHOOK_SHOP_MISMATCH")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(400, "INVALID_WEBHOOK_JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(400, "INVALID_WEBHOOK_PAYLOAD")
    # Refuse Shopify's documented sample order; a Send test delivery must never arm ads.
    if str(payload.get("id")) == "820982911946105508" or payload.get("test") is True:
        return {"accepted": True, "ignored": "TEST_DELIVERY"}
    body_hash = hashlib.sha256(raw).hexdigest()
    def save():
        return PaymentWebhookStore(payment_database(env)).accept(topic=topic, payload=payload,
                    body_hash=body_hash, shop=shop, now=now or datetime.now(UTC), env=env)
    return await asyncio.to_thread(save)
