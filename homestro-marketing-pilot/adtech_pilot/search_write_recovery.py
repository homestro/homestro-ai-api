"""Bounded observational recovery for persisted paused search write intents.

Never changes an original write intent or sends a campaign mutation. A matching
campaign is not proof of a complete ad bundle, delivery, purchases or authorization.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime

import httpx

from .microsoft_auth import access_token, missing_auth
from .search_channels import _bounded_json

TABLES = {'google': 'pilot_google_writes', 'microsoft': 'pilot_microsoft_writes'}
DIGITS = re.compile(r'\d{1,20}')
HASH = re.compile(r'[a-f0-9]{64}')


def campaign_identity(identity, intent, account):
    """Only compiler-derived names and consistent, already persisted IDs are owned."""
    draft_id = intent.get('draft_id', '')
    if (not HASH.fullmatch(str(draft_id)) or intent.get('account_id') != account
            or identity != account + ':' + draft_id):
        raise ValueError('PERSISTED_INTENT_IDENTITY_INVALID')
    known = []
    if intent.get('campaign_id') is not None:
        known.append(intent['campaign_id'])
    campaigns = (intent.get('steps') or {}).get('Campaigns') or {}
    for field in ('ids', 'returned_ids'):
        values = campaigns.get(field, [])
        if not isinstance(values, list) or len(values) > 1:
            raise ValueError('PERSISTED_CAMPAIGN_IDS_AMBIGUOUS')
        known.extend(values)
    if any(not isinstance(value, str) or not DIGITS.fullmatch(value) for value in known):
        raise ValueError('PERSISTED_CAMPAIGN_ID_INVALID')
    unique = set(known)
    if len(unique) > 1:
        raise ValueError('PERSISTED_CAMPAIGN_IDS_CONFLICT')
    return 'Homestro Search ' + draft_id[:16], next(iter(unique), None)


def observation(rows, *, account, name, campaign_id):
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('CAMPAIGN_READBACK_INVALID')
    candidates = [row for row in rows if (str(row.get('id')) == campaign_id if campaign_id else row.get('name') == name)]
    if not candidates:
        return {'status': 'not_observed', 'reason': 'NO_MATCH_IN_BOUNDED_READ', 'campaign_paused_verified': False}
    if len(candidates) != 1:
        return {'status': 'ambiguous', 'reason': 'MULTIPLE_REMOTE_MATCHES', 'campaign_paused_verified': False}
    row = candidates[0]
    remote_id = str(row.get('id', ''))
    if not DIGITS.fullmatch(remote_id) or row.get('name') != name:
        return {'status': 'identity_mismatch', 'reason': 'EXACT_CAMPAIGN_ID_AND_NAME_REQUIRED', 'campaign_paused_verified': False}
    if campaign_id is None:
        # A name can reveal a lost-response candidate, never replace a missing ID receipt.
        return {'status': 'identity_unconfirmed', 'reason': 'PERSISTED_PROVIDER_ID_REQUIRED',
                'candidate_campaign_id': remote_id, 'campaign_paused_verified': False}
    status = str(row.get('status', '')).upper()
    if status not in {'PAUSED', 'ENABLED', 'ACTIVE', 'REMOVED', 'DELETED', 'BUDGETPAUSED', 'SUSPENDED'}:
        raise ValueError('CAMPAIGN_STATUS_UNCONFIRMED')
    return {'status': 'campaign_paused_observed' if status == 'PAUSED' else 'campaign_state_observed',
            'account_id': account, 'campaign_id': campaign_id, 'remote_status': status,
            'identity_confirmed': True, 'campaign_paused_verified': status == 'PAUSED'}


class SearchWriteRecovery:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS pilot_search_write_readbacks (
                channel TEXT NOT NULL, identity TEXT NOT NULL, observed_at TEXT NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(channel,identity))''')

    def intents(self, channel):
        table = TABLES[channel]
        with closing(self.audit._connect()) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                return []
            return db.execute(f'''SELECT w.identity,w.payload FROM {table} w
                LEFT JOIN pilot_search_write_readbacks r ON r.channel=? AND r.identity=w.identity
                ORDER BY COALESCE(r.observed_at,''),w.identity LIMIT 20''', (channel,)).fetchall()

    def save(self, channel, identity, result, now):
        record = {**result, 'observed_at': now.isoformat(), 'writes_performed': False,
                  'full_bundle_verified': False, 'ad_delivery_verified': False,
                  'activation_authorized': False, 'authorized_spend_eur': 0,
                  'original_intent_modified': False, 'evidence_level': 'provider_campaign_readback_only'}
        with closing(self.audit._connect()) as db, db:
            db.execute('''INSERT INTO pilot_search_write_readbacks VALUES (?,?,?,?)
                ON CONFLICT(channel,identity) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload''',
                (channel, identity, now.isoformat(), json.dumps(record)))
        return record

    async def cycle(self, *, env=None, client=None, now=None):
        env = os.environ if env is None else env
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        batches = {channel: self.intents(channel) for channel in TABLES}
        if not any(batches.values()):
            return {'status': 'no_intents', 'channels': {}, 'checked': 0, 'writes_performed': False,
                    'original_intents_modified': False, 'activation_authorized': False}
        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        channels = {}
        try:
            for channel, batch in batches.items():
                if not batch:
                    channels[channel] = {'status': 'no_intents', 'checked': 0, 'results': []}
                    continue
                account = env.get('GOOGLE_ADS_CUSTOMER_ID' if channel == 'google' else 'MICROSOFT_ADS_ACCOUNT_ID', '').replace('-', '')
                required = (['GOOGLE_ADS_DEVELOPER_TOKEN'] if channel == 'google' else
                            ['MICROSOFT_ADS_CUSTOMER_ID', 'MICROSOFT_ADS_DEVELOPER_TOKEN'])
                required += ([] if env.get('GOOGLE_ADS_ACCESS_TOKEN') else
                             ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN']) if channel == 'google' else missing_auth(env)
                missing = [key for key in required if not env.get(key)]
                if not account or missing:
                    channels[channel] = {'status': 'not_configured', 'checked': 0, 'pending_intents': len(batch),
                                         'missing_settings': missing, 'account_configured': bool(account), 'results': []}
                    continue
                if (not re.fullmatch(r'\d{10}' if channel == 'google' else r'\d{1,20}', account)
                        or (channel == 'microsoft' and not DIGITS.fullmatch(env['MICROSOFT_ADS_CUSTOMER_ID']))):
                    channels[channel] = {'status': 'blocked', 'reason': 'CONFIGURED_ACCOUNT_INVALID', 'checked': 0, 'results': []}
                    continue
                results, reader, reader_failed = [], None, False
                for identity, raw in batch:
                    try:
                        intent = json.loads(raw)
                        name, campaign_id = campaign_identity(identity, intent, account)
                        if reader_failed:
                            raise ValueError('PROVIDER_IDENTITY_READ_UNAVAILABLE')
                        if reader is None:
                            try:
                                reader = await self.reader(channel, account, env, client)
                            except (ValueError, TypeError, KeyError, IndexError, AttributeError, httpx.HTTPError):
                                reader_failed = True
                                raise
                        rows = await reader(name, campaign_id)
                        result = observation(rows, account=account, name=name, campaign_id=campaign_id)
                    except (ValueError, TypeError, KeyError, IndexError, AttributeError, httpx.HTTPError) as exc:
                        result = {'status': 'unavailable', 'error_type': type(exc).__name__,
                                  'reason': 'PERSISTED_IDENTITY_OR_PROVIDER_READBACK_UNCONFIRMED', 'campaign_paused_verified': False}
                    results.append({'intent_identity': identity, **self.save(channel, identity, result, now)})
                channels[channel] = {'status': 'checked', 'checked': len(results), 'results': results,
                                     'campaign_paused_observations': sum(r.get('campaign_paused_verified') is True for r in results)}
            return {'status': 'checked', 'checked': sum(row['checked'] for row in channels.values()),
                    'channels': channels, 'writes_performed': False, 'original_intents_modified': False,
                    'activation_authorized': False, 'full_bundle_verified': False}
        finally:
            if own:
                await client.aclose()

    async def reader(self, channel, account, env, client):
        """Provider queries only; never return a write-capable transport."""
        if channel == 'google':
            version = env.get('GOOGLE_ADS_API_VERSION', 'v26')
            manager = env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace('-', '')
            if not re.fullmatch(r'v\d{1,3}', version) or (manager and not re.fullmatch(r'\d{10}', manager)):
                raise ValueError('GOOGLE_CONFIGURATION_INVALID')
            token = env.get('GOOGLE_ADS_ACCESS_TOKEN')
            if not token:
                token = (await _bounded_json(client, 'https://oauth2.googleapis.com/token', data={
                    'grant_type': 'refresh_token', 'client_id': env['GOOGLE_ADS_CLIENT_ID'],
                    'client_secret': env['GOOGLE_ADS_CLIENT_SECRET'], 'refresh_token': env['GOOGLE_ADS_REFRESH_TOKEN']}))['access_token']
            headers = {'Authorization': 'Bearer ' + token, 'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']}
            if manager:
                headers['login-customer-id'] = manager
            endpoint = f'https://googleads.googleapis.com/{version}/customers/{account}/googleAds:searchStream'
            async def query(text):
                reply = await _bounded_json(client, endpoint, headers=headers, json={'query': text})
                if not isinstance(reply, list) or len(reply) > 10:
                    raise ValueError('GOOGLE_READBACK_INVALID')
                return [row for chunk in reply for row in chunk.get('results', [])]
            customers = await query('SELECT customer.id,customer.currency_code FROM customer LIMIT 1')
            if len(customers) != 1 or str(customers[0]['customer']['id']) != account or customers[0]['customer'].get('currencyCode') != 'EUR':
                raise ValueError('GOOGLE_ACCOUNT_OR_CURRENCY_MISMATCH')
            async def google(name, campaign_id):
                condition = f'campaign.id = {campaign_id}' if campaign_id else "campaign.name = '" + name + "'"
                rows = await query('SELECT campaign.id,campaign.name,campaign.status FROM campaign WHERE ' + condition + ' LIMIT 2')
                if len(rows) > 2:
                    raise ValueError('GOOGLE_READBACK_ROW_LIMIT')
                return [row['campaign'] for row in rows]
            return google
        token = await access_token(env, client, audit=self.audit)
        headers = {'Authorization': 'Bearer ' + token, 'DeveloperToken': env['MICROSOFT_ADS_DEVELOPER_TOKEN'],
                   'CustomerAccountId': account, 'CustomerId': env['MICROSOFT_ADS_CUSTOMER_ID']}
        reply = await _bounded_json(client, 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/Account/Query',
                                    headers=headers, json={'AccountId': int(account)})
        customer = reply['Account']
        if str(customer['Id']) != account or customer.get('CurrencyCode') != 'EUR':
            raise ValueError('MICROSOFT_ACCOUNT_OR_CURRENCY_MISMATCH')
        reply = await _bounded_json(client, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId',
                                    headers=headers, json={'AccountId': int(account), 'CampaignType': 'Search'})
        rows = reply['Campaigns']
        if rows is None:
            rows = []
        if not isinstance(rows, list) or len(rows) >= 500:
            raise ValueError('MICROSOFT_INVENTORY_INCOMPLETE')
        normalized = [{'id': str(row['Id']), 'name': row['Name'], 'status': row['Status']} for row in rows]
        async def microsoft(_name, _campaign_id):
            return normalized
        return microsoft
