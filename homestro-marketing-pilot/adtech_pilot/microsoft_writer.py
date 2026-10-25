"""Default-off paused Microsoft draft writer with durable per-operation intents.

No campaign activation. Targeting must still be independently verified before any
future activation. Partial/lost outcomes retain known IDs and never replay creates.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime

import httpx

from .microsoft_auth import access_token, missing_auth
from .search_campaigns import microsoft_request_templates, verify_draft
from .search_channels import _bounded_json

BASE = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/'


class MicrosoftPausedWriter:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_microsoft_writes (identity TEXT PRIMARY KEY,payload TEXT NOT NULL)')

    def load(self, identity):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT payload FROM pilot_microsoft_writes WHERE identity=?', (identity,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, identity, payload, *, reserve=False):
        with closing(self.audit._connect()) as db, db:
            if reserve:
                return db.execute('INSERT OR IGNORE INTO pilot_microsoft_writes VALUES(?,?)',
                                  (identity, json.dumps(payload))).rowcount == 1
            db.execute('UPDATE pilot_microsoft_writes SET payload=? WHERE identity=?', (json.dumps(payload), identity))
        return True

    async def create_paused(self, draft, *, approved_revision, proposed_daily_eur='5.00', env=None, client=None):
        env = os.environ if env is None else env
        if env.get('MICROSOFT_ADS_PAUSED_CREATION_AUTHORIZED') != 'true':
            return {'status': 'disabled', 'reason': 'MICROSOFT_CAMPAIGN_CREATION_NOT_AUTHORIZED', 'writes_performed': False}
        verify_draft(draft)
        if draft['channel'] != 'microsoft' or draft['revision'] != approved_revision:
            raise ValueError('CURRENT_MICROSOFT_DRAFT_APPROVAL_REQUIRED')
        keys = ['MICROSOFT_ADS_ACCOUNT_ID', 'MICROSOFT_ADS_CUSTOMER_ID', 'MICROSOFT_ADS_DEVELOPER_TOKEN']
        missing = [key for key in keys if not env.get(key)] + missing_auth(env)
        if missing:
            return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
        account, customer = env[keys[0]], env[keys[1]]
        if any(not re.fullmatch(r'\d{1,20}', value) for value in (account, customer)):
            raise ValueError('MICROSOFT_ACCOUNT_INVALID')
        identity = account + ':' + draft['id']
        previous = self.load(identity)
        if previous:
            return {'status': 'existing_write_intent', 'stored_receipt': previous,
                    'writes_performed': False, 'current_remote_state_verified': False}
        templates = microsoft_request_templates(draft, account, proposed_daily_eur=proposed_daily_eur)
        headers = {'DeveloperToken': env[keys[2]],
                   'CustomerAccountId': account, 'CustomerId': customer}
        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)
        state = None
        attempted = False
        try:
            headers['Authorization'] = 'Bearer ' + await access_token(env, client, audit=self.audit)
            async def inventory():
                reply = await _bounded_json(client, BASE + 'Campaigns/QueryByAccountId', headers=headers,
                                            json={'AccountId': int(account), 'CampaignType': 'Search'})
                rows = reply['Campaigns'] or []
                if not isinstance(rows, list) or len(rows) > 500:
                    raise ValueError('MICROSOFT_INVENTORY_INCOMPLETE')
                return rows
            account_reply = await _bounded_json(client,
                'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/Account/Query',
                headers=headers, json={'AccountId': int(account)})
            observed = account_reply['Account']
            if str(observed['Id']) != account or observed.get('CurrencyCode') != 'EUR':
                raise ValueError('MICROSOFT_ACCOUNT_OR_CURRENCY_MISMATCH')
            if any(row.get('Name') == draft['campaign_name'] for row in await inventory()):
                return {'status': 'hold', 'reason': 'EXISTING_EXACT_NAME_CAMPAIGN_REQUIRES_RECONCILIATION', 'writes_performed': False}
            state = {'status': 'write_uncertain', 'revision': draft['revision'], 'draft_id': draft['id'],
                'account_id': account, 'created_at': datetime.now(UTC).isoformat(), 'steps': {},
                'activation_authorized': False, 'authorized_spend_eur': 0, 'targeting_verified': False,
                'activation_blockers': ['DE_AT_LOCATION_AND_PRESENCE_READBACK_REQUIRED', 'PURCHASE_VERIFICATION_REQUIRED',
                                        'CHANNEL_SPEND_AUTHORIZATION_REQUIRED']}
            if not self.save(identity, state, reserve=True):
                return {'status': 'hold', 'reason': 'EXISTING_WRITE_INTENT', 'writes_performed': False}
            remote = {}
            steps = [('Campaigns', 'CampaignIds', 1), ('AdGroups', 'AdGroupIds', 1),
                     ('Ads', 'AdIds', 1), ('Keywords', 'KeywordIds', len(draft['keywords']))]
            for index, (endpoint, field, count) in enumerate(steps):
                body = templates['requests'][index]['body']
                def bind(value):
                    if isinstance(value, dict):
                        return {key: bind(item) for key, item in value.items()}
                    if isinstance(value, list):
                        return [bind(item) for item in value]
                    if value == '$CAMPAIGN_ID':
                        return int(remote['Campaigns'][0])
                    if value == '$AD_GROUP_ID':
                        return int(remote['AdGroups'][0])
                    return value
                body = bind(body)
                entities = body[endpoint]
                if not entities or any(row.get('Status') != 'Paused' for row in entities):
                    raise ValueError('MICROSOFT_PAUSED_ENTITIES_REQUIRED')
                state['steps'][endpoint] = {'state': 'intent'}
                self.save(identity, state)
                attempted = True
                reply = await _bounded_json(client, BASE + endpoint, headers=headers, json=body)
                ids = reply.get(field)
                if isinstance(ids, list):
                    state['steps'][endpoint]['returned_ids'] = [str(value) for value in ids
                                                               if re.fullmatch(r'\d{1,20}', str(value))]
                    self.save(identity, state)
                if (reply.get('PartialErrors') or reply.get('NestedPartialErrors') or not isinstance(ids, list)
                    or len(ids) != count or any(not re.fullmatch(r'\d{1,20}', str(value)) for value in ids)
                    or len(set(map(str, ids))) != count):
                    raise ValueError('MICROSOFT_CREATE_RESPONSE_UNCONFIRMED')
                remote[endpoint] = list(map(str, ids))
                state['steps'][endpoint] = {'state': 'response_received', 'ids': remote[endpoint]}
                self.save(identity, state)
            state.update(status='created_readback_pending', campaign_id=remote['Campaigns'][0])
            self.save(identity, state)
            rows = [row for row in await inventory() if str(row.get('Id')) == state['campaign_id']]
            if len(rows) == 1 and rows[0].get('Status') == 'Paused' and rows[0].get('Name') == draft['campaign_name']:
                state['status'] = 'campaign_paused_confirmed'
                self.save(identity, state)
            return {**state, 'writes_performed': True, 'full_ad_delivery_verified': False}
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, httpx.HTTPError) as exc:
            if state:
                state.update(status='write_uncertain', error_type=type(exc).__name__)
                self.save(identity, state)
            return {'status': 'write_uncertain' if attempted else 'blocked', 'error_type': type(exc).__name__,
                    'writes_performed': attempted, 'activation_authorized': False, 'authorized_spend_eur': 0}
        finally:
            if own:
                await client.aclose()
