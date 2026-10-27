"""Consent/suppression ledger and opt-in SMTP delivery, disabled by default.

No addresses or message bodies are persisted. SMTP acceptance is not delivery evidence.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import smtplib
import ssl
from contextlib import closing
from datetime import UTC, datetime
from email.message import EmailMessage
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


def address(value):
    if not isinstance(value, str) or len(value) > 254 or not re.fullmatch(r'[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+', value):
        raise ValueError('INVALID_EMAIL_ADDRESS')
    return value.strip().lower()


class EmailDelivery:
    def __init__(self, audit, *, secret):
        if len(secret) < 32:
            raise ValueError('EXISTING_ADMIN_KEY_REQUIRED')
        self.audit, self.secret = audit, secret.encode()
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_email_consent (recipient TEXT PRIMARY KEY, active INTEGER NOT NULL, observed_at TEXT NOT NULL, evidence TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS pilot_email_delivery (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, day TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)')

    def recipient_key(self, recipient):
        return hmac.new(self.secret, ('email-recipient-v1:' + address(recipient)).encode(), hashlib.sha256).hexdigest()

    def signature(self, recipient_key):
        return hmac.new(self.secret, ('email-unsubscribe-v1:' + recipient_key).encode(), hashlib.sha256).hexdigest()

    def consent(self, recipient, *, observed_at, evidence_id, confirmed, now=None):
        now = now or datetime.now(UTC)
        observed = datetime.fromisoformat(observed_at.replace('Z', '+00:00'))
        if not confirmed or observed.tzinfo is None or observed > now or not evidence_id or len(evidence_id) > 100:
            raise ValueError('ACTUAL_TIMESTAMPED_CONSENT_REQUIRED')
        key = self.recipient_key(recipient)
        with closing(self.audit._connect()) as db, db:
            existing = db.execute('SELECT observed_at FROM pilot_email_consent WHERE recipient=?', (key,)).fetchone()
            if existing and datetime.fromisoformat(existing[0]) >= observed:
                return {'status': 'unchanged', 'recipient_key': key}
            db.execute('INSERT INTO pilot_email_consent VALUES (?,1,?,?) ON CONFLICT(recipient) DO UPDATE SET active=1,observed_at=excluded.observed_at,evidence=excluded.evidence',
                       (key, observed.isoformat(), evidence_id))
        return {'status': 'consent_recorded', 'recipient_key': key, 'messages_sent': 0}

    def unsubscribe(self, recipient_key, signature, *, now=None):
        if not re.fullmatch(r'[a-f0-9]{64}', recipient_key) or not hmac.compare_digest(self.signature(recipient_key), signature):
            raise ValueError('INVALID_UNSUBSCRIBE_SIGNATURE')
        now = now or datetime.now(UTC)
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_email_consent VALUES (?,0,?,?) ON CONFLICT(recipient) DO UPDATE SET active=0,observed_at=excluded.observed_at,evidence=excluded.evidence',
                       (recipient_key, now.isoformat(), 'recipient_unsubscribe'))
        return {'status': 'unsubscribed', 'messages_sent': 0}

    async def send(self, *, recipient, subject, body, campaign_id, owner_authorized, env, smtp_factory=None, now=None):
        if env.get('PILOT_EMAIL_SEND_ENABLED', 'false') != 'true' or owner_authorized is not True:
            return {'status': 'blocked', 'reason': 'EMAIL_SEND_NOT_AUTHORIZED'}
        recipient = address(recipient)
        sender = address(env.get('PILOT_EMAIL_FROM', ''))
        if not subject or len(subject) > 180 or '\n' in subject or '\r' in subject or not body or len(body) > 15000:
            raise ValueError('INVALID_EMAIL_CONTENT')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', campaign_id):
            raise ValueError('INVALID_EMAIL_CAMPAIGN')
        host = env.get('PILOT_SMTP_HOST', '')
        if not re.fullmatch(r'[a-zA-Z0-9.-]{3,253}', host):
            raise ValueError('SMTP_HOST_REQUIRED')
        origin = env.get('PILOT_PUBLIC_ORIGIN', '')
        parsed = urlsplit(origin)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
            raise ValueError('UNSUBSCRIBE_ORIGIN_REQUIRED')
        limit = int(env.get('PILOT_EMAIL_DAILY_LIMIT', '0'))
        if not 1 <= limit <= 100:
            raise ValueError('EXPLICIT_EMAIL_DAILY_LIMIT_REQUIRED')
        now = now or datetime.now(UTC)
        day = now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
        key = self.recipient_key(recipient)
        identity = hashlib.sha256(json.dumps([key, campaign_id, subject, body]).encode()).hexdigest()
        with closing(self.audit._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            consent = db.execute('SELECT active FROM pilot_email_consent WHERE recipient=?', (key,)).fetchone()
            if not consent or consent[0] != 1:
                return {'status': 'blocked', 'reason': 'RECIPIENT_NOT_OPTED_IN_OR_SUPPRESSED'}
            existing = db.execute('SELECT state FROM pilot_email_delivery WHERE id=?', (identity,)).fetchone()
            if existing:
                return {'status': existing[0], 'message_id': identity, 'repeat_submission': False}
            rows = db.execute("SELECT recipient FROM pilot_email_delivery WHERE day=? AND state IN ('reserved','accepted','uncertain')", (day,)).fetchall()
            if len(rows) >= limit or any(row[0] == key for row in rows):
                return {'status': 'blocked', 'reason': 'DAILY_OR_RECIPIENT_FREQUENCY_LIMIT'}
            db.execute('INSERT INTO pilot_email_delivery VALUES (?,?,?,?,?)',
                       (identity, key, day, 'reserved', json.dumps({'campaign_id': campaign_id})))
        unsubscribe = origin.rstrip('/') + '/email/unsubscribe/' + key + '/' + self.signature(key)
        message = EmailMessage()
        message['From'], message['To'], message['Subject'] = sender, recipient, subject
        message['Message-ID'] = '<' + identity + '@' + sender.split('@')[1] + '>'
        message['List-Unsubscribe'] = '<' + unsubscribe + '>'
        message['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
        message.set_content(body + '\n\nAbmelden: ' + unsubscribe)
        def deliver():
            factory = smtp_factory or smtplib.SMTP_SSL
            with factory(host, 465, timeout=15, context=ssl.create_default_context()) as smtp:
                if env.get('PILOT_SMTP_USERNAME'):
                    smtp.login(env['PILOT_SMTP_USERNAME'], env.get('PILOT_SMTP_PASSWORD', ''))
                # Suppression is rechecked immediately before the network write.
                with closing(self.audit._connect()) as db:
                    active = db.execute('SELECT active FROM pilot_email_consent WHERE recipient=?', (key,)).fetchone()
                if not active or active[0] != 1:
                    return 'suppressed'
                return 'rejected' if smtp.send_message(message) else 'accepted'
        try:
            async with asyncio.timeout(45):
                state = await asyncio.to_thread(deliver)
        except Exception:
            # A lost SMTP response might have accepted the message. Never replay.
            state = 'uncertain'
        with closing(self.audit._connect()) as db, db:
            db.execute('UPDATE pilot_email_delivery SET state=? WHERE id=?', (state, identity))
        return {'status': state, 'message_id': identity, 'smtp_acceptance_only': state == 'accepted',
                'delivery_verified': False, 'purchase_verified': False}
