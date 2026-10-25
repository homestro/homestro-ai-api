"""Reserved, validation-first Google bundle creation. Every created entity is paused.

No activation path. Current zero-spend policy leaves creation disabled. A lost write
response is a durable hold, never another create request.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime

import httpx

from .search_campaigns import validate_google_draft, verify_draft
from .search_channels import _bounded_json


class GooglePausedWriter:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_google_writes (identity TEXT PRIMARY KEY,payload TEXT NOT NULL)')

    def record(self, identity, payload, *, reserve=False):
        with closing(self.audit._connect()) as db, db:
            if reserve:
                return db.execute('INSERT OR IGNORE INTO pilot_google_writes VALUES(?,?)',
                                  (identity, json.dumps(payload))).rowcount == 1
            db.execute('UPDATE pilot_google_writes SET payload=? WHERE identity=?', (json.dumps(payload), identity))
        return True

    def existing(self, identity):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT payload FROM pilot_google_writes WHERE identity=?', (identity,)).fetchone()
        return json.loads(row[0]) if row else None

    async def create_paused(self, draft, *, approved_revision, proposed_daily_eur='5.00', env=None, client=None):
        env = os.environ if env is None else env
        if env.get('GOOGLE_ADS_PAUSED_CREATION_AUTHORIZED') != 'true':
            return {'status': 'disabled', 'reason': 'GOOGLE_CAMPAIGN_CREATION_NOT_AUTHORIZED', 'writes_performed': False}
        verify_draft(draft)
        if draft['channel'] != 'google' or approved_revision != draft['revision']:
            raise ValueError('CURRENT_GOOGLE_DRAFT_APPROVAL_REQUIRED')
        account = env.get('GOOGLE_ADS_CUSTOMER_ID', '').replace('-', '')
        version = env.get('GOOGLE_ADS_API_VERSION', 'v26')
        if not re.fullmatch(r'\d{10}', account) or not re.fullmatch(r'v\d{1,3}', version):
            return {'status': 'not_configured', 'reason': 'GOOGLE_ACCOUNT_OR_VERSION_INVALID', 'writes_performed': False}
        identity = account + ':' + draft['id']
        previous = self.existing(identity)
        if previous:
            return {'status': 'existing_write_intent', 'stored_receipt': previous, 'current_remote_state_verified': False,
                    'writes_performed': False, 'replayed_create': False}
        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)
        attempted = False
        intent = None
        try:
            validation = await validate_google_draft(draft, proposed_daily_eur=proposed_daily_eur,
                                                     env=env, client=client, include_request=True)
            if validation.get('status') != 'provider_validated_only':
                return {key: value for key, value in validation.items() if key != 'validated_request'}
            request = validation['validated_request']
            token = env.get('GOOGLE_ADS_ACCESS_TOKEN')
            if not token:
                auth = await _bounded_json(client, 'https://oauth2.googleapis.com/token', data={
                    'grant_type': 'refresh_token', 'client_id': env['GOOGLE_ADS_CLIENT_ID'],
                    'client_secret': env['GOOGLE_ADS_CLIENT_SECRET'], 'refresh_token': env['GOOGLE_ADS_REFRESH_TOKEN']})
                token = auth['access_token']
            headers = {'Authorization': 'Bearer ' + token, 'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']}
            manager = env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace('-', '')
            if manager:
                if not re.fullmatch(r'\d{10}', manager):
                    raise ValueError('INVALID_GOOGLE_MANAGER')
                headers['login-customer-id'] = manager
            base = f'https://googleads.googleapis.com/{version}/customers/{account}/googleAds:'
            # The compiler's deterministic name contains no user-supplied GAQL syntax.
            if not re.fullmatch(r'Homestro Search [a-f0-9]{16}', draft['campaign_name']):
                raise ValueError('INVALID_MANAGED_CAMPAIGN_NAME')
            async def lookup():
                reply = await _bounded_json(client, base + 'searchStream', headers=headers, json={'query':
                    "SELECT campaign.id,campaign.name,campaign.status FROM campaign WHERE campaign.name = '" + draft['campaign_name'] + "' AND campaign.status != 'REMOVED'"})
                return [row['campaign'] for chunk in reply for row in chunk.get('results', [])]
            found = await lookup()
            if found:
                return {'status': 'hold', 'reason': 'EXISTING_EXACT_NAME_CAMPAIGN_REQUIRES_RECONCILIATION', 'writes_performed': False}
            # Only change validateOnly after independently checking all status fields.
            operations = request['mutateOperations']
            statuses = [obj['create']['status'] for operation in operations for obj in operation.values()
                        if isinstance(obj, dict) and 'status' in obj.get('create', {})]
            if not statuses or any(status != 'PAUSED' for status in statuses) or request.get('partialFailure') is not False:
                raise ValueError('PAUSED_ATOMIC_BUNDLE_REQUIRED')
            request['validateOnly'] = False
            intent = {'status': 'write_uncertain', 'account_id': account, 'draft_id': draft['id'],
                      'revision': draft['revision'], 'created_at': datetime.now(UTC).isoformat(),
                      'campaign_id': None, 'activation_authorized': False, 'authorized_spend_eur': 0,
                      'proposed_daily_eur': str(proposed_daily_eur)}
            if not self.record(identity, intent, reserve=True):
                return {'status': 'hold', 'reason': 'EXISTING_WRITE_INTENT', 'writes_performed': False}
            attempted = True
            reply = await _bounded_json(client, base + 'mutate', headers=headers, json=request)
            if reply.get('error') or reply.get('partialFailureError'):
                raise ValueError('GOOGLE_CREATE_NOT_CONFIRMED')
            resources = [row['campaignResult']['resourceName'] for row in reply.get('mutateOperationResponses', []) if 'campaignResult' in row]
            if len(resources) != 1 or not re.fullmatch(r'customers/' + account + r'/campaigns/\d+', resources[0]):
                raise ValueError('GOOGLE_CAMPAIGN_RESOURCE_UNCONFIRMED')
            campaign_id = resources[0].rsplit('/', 1)[-1]
            intent.update(campaign_id=campaign_id, status='created_readback_pending')
            self.record(identity, intent)
            found = await lookup()
            if len(found) == 1 and str(found[0]['id']) == campaign_id and found[0]['status'] == 'PAUSED':
                intent['status'] = 'campaign_paused_confirmed'
                self.record(identity, intent)
            return {**intent, 'writes_performed': True, 'full_ad_delivery_verified': False}
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, httpx.HTTPError) as exc:
            if intent and attempted:
                intent['error_type'] = type(exc).__name__
                self.record(identity, intent)
            return {'status': 'write_uncertain' if attempted else 'blocked', 'error_type': type(exc).__name__,
                    'writes_performed': attempted, 'activation_authorized': False, 'authorized_spend_eur': 0}
        finally:
            if own:
                await client.aclose()
