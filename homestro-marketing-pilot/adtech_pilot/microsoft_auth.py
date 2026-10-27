"""Existing direct-token compatibility plus encrypted persistent OAuth token rotation."""
from __future__ import annotations

import base64
import hashlib
import json
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

OAUTH_KEYS = ('MICROSOFT_ADS_CLIENT_ID', 'MICROSOFT_ADS_CLIENT_SECRET', 'MICROSOFT_ADS_REFRESH_TOKEN')


def missing_auth(env):
    if env.get('MICROSOFT_ADS_ACCESS_TOKEN'):
        return []
    return [name for name in OAUTH_KEYS if not env.get(name)]


async def access_token(env, client, *, audit=None, now=None):
    if not all(env.get(name) for name in OAUTH_KEYS):
        token = env.get('MICROSOFT_ADS_ACCESS_TOKEN')
        if not token:
            raise ValueError('MICROSOFT_OAUTH_OR_ACCESS_TOKEN_REQUIRED')
        return token
    secret = env.get('PILOT_ADS_TOKEN_ENCRYPTION_SECRET') or env.get('PILOT_ADMIN_KEY', '')
    if len(secret) < 32:
        raise ValueError('MICROSOFT_TOKEN_STORAGE_SECRET_REQUIRED')
    cipher = Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))
    identity = hashlib.sha256(json.dumps([env[key] for key in OAUTH_KEYS], separators=(',', ':')).encode()).hexdigest()
    if audit is None:
        from .media_buyer import PlanAuditStore
        audit = PlanAuditStore(Path(env.get('PILOT_AUDIT_DB_PATH', '/tmp/homestro-adtech/audit.sqlite3')))
    now = now or datetime.now(UTC)
    with closing(audit._connect()) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS pilot_microsoft_oauth (identity TEXT PRIMARY KEY,ciphertext TEXT NOT NULL)')
        row = db.execute('SELECT ciphertext FROM pilot_microsoft_oauth WHERE identity=?', (identity,)).fetchone()
    try:
        saved = json.loads(cipher.decrypt(row[0].encode())) if row else None
    except InvalidToken as exc:
        raise ValueError('MICROSOFT_TOKEN_STORAGE_KEY_MISMATCH') from exc
    if saved and datetime.fromisoformat(saved['expires_at']) > now + timedelta(minutes=2):
        return saved['access_token']
    from .search_channels import _bounded_json
    reply = await _bounded_json(client, 'https://login.microsoftonline.com/common/oauth2/v2.0/token', data={
        'grant_type': 'refresh_token', 'client_id': env['MICROSOFT_ADS_CLIENT_ID'],
        'client_secret': env['MICROSOFT_ADS_CLIENT_SECRET'], 'scope': 'https://ads.microsoft.com/msads.manage offline_access',
        'refresh_token': saved['refresh_token'] if saved else env['MICROSOFT_ADS_REFRESH_TOKEN']})
    token, refresh, expires = reply['access_token'], reply.get('refresh_token') or (saved['refresh_token'] if saved else env['MICROSOFT_ADS_REFRESH_TOKEN']), reply['expires_in']
    if not isinstance(token, str) or not token or not isinstance(refresh, str) or not refresh or type(expires) is not int or not 120 < expires <= 86400:
        raise ValueError('MICROSOFT_OAUTH_RESPONSE_INVALID')
    encrypted = cipher.encrypt(json.dumps({'access_token': token, 'refresh_token': refresh,
        'expires_at': (now + timedelta(seconds=expires)).isoformat()}).encode()).decode()
    with closing(audit._connect()) as db, db:
        db.execute('INSERT INTO pilot_microsoft_oauth VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET ciphertext=excluded.ciphertext',
                   (identity, encrypted))
    return token
