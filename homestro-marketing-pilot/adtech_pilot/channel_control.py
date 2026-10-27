"""Conservative, common-budget planner and official stop-only search transports.

A plan never grants spend. No resume, budget increase or campaign creation exists here.
"""
from __future__ import annotations

import os
import re
from decimal import Decimal

import httpx

from .search_channels import _bounded_json

CHANNELS = ('meta', 'google', 'microsoft')


def amount(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0:
        raise ValueError('INVALID_CHANNEL_MONEY')
    return number


def allocation_plan(observations, *, authorized_daily_eur='0', measurement_verified=False):
    """Keep a single global cap; never multiply a five-EUR test across channels.

    Inputs must already be normalized to the same EUR reporting window. Unknown
    accounting or incomplete data cannot become a winner. This is a proposal only.
    """
    cap = amount(authorized_daily_eur)
    if cap > 5 or cap != cap.quantize(Decimal('.01')):
        raise ValueError('GLOBAL_DAILY_CAP_EXCEEDED')
    candidates, rows = [], []
    for channel in CHANNELS:
        raw = observations.get(channel, {})
        row = {'channel': channel, 'proposed_daily_eur': '0.00', 'reason': 'INCOMPLETE_COMMON_ACCOUNTING'}
        if not measurement_verified or cap == 0:
            row['reason'] = 'PURCHASE_HARD_LOCK' if not measurement_verified else 'NO_SPEND_AUTHORIZATION'
        elif (raw.get('currency') == 'EUR' and raw.get('fresh') is True and raw.get('costs_complete') is True
              and raw.get('signed_orders_verified') is True and raw.get('channel_spend_authorized') is True
              and raw.get('common_window_verified') is True and type(raw.get('orders')) is int and raw['orders'] > 0):
            try:
                contribution = Decimal(str(raw['contribution_after_ads_eur']))
                spend = amount(raw['spend_eur'])
                if contribution.is_finite() and contribution > 0 and spend > 0:
                    candidates.append((contribution / spend, channel))
                    row['reason'] = 'ELIGIBLE_FOR_REVIEW'
            except (ValueError, TypeError, ArithmeticError, KeyError):
                pass
        rows.append(row)
    # No division/rounding can exceed the global cap: at most one reviewed winner.
    if candidates:
        winner = sorted(candidates, key=lambda item: (-item[0], item[1]))[0][1]
        for row in rows:
            if row['channel'] == winner:
                row.update(proposed_daily_eur=str(cap.quantize(Decimal('.01'))), reason='POSITIVE_OBSERVED_CONTRIBUTION')
    return {'mode': 'proposal_only', 'channels': rows, 'global_daily_cap_eur': str(cap),
            'allocated_daily_eur': str(sum((Decimal(row['proposed_daily_eur']) for row in rows), Decimal('0'))),
            'writes_performed': False, 'scale_authorized': False, 'causal_lift_verified': False}


async def pause_search_campaign(channel, campaign_id, *, expected_account, env=None, client=None):
    """Idempotent PAUSE only, after exact configured-account binding and independent readback.

    Callers must supply a persisted, owned campaign identity. This low-level function
    is not exposed as a public arbitrary-provider proxy. Lost replies are reconciled
    by later inventory reads; no creation is ever retried.
    """
    env = os.environ if env is None else env
    if channel not in {'google', 'microsoft'} or not re.fullmatch(r'\d{1,20}', str(campaign_id)):
        raise ValueError('SEARCH_CHANNEL_OR_CAMPAIGN_INVALID')
    prefix = 'GOOGLE_ADS' if channel == 'google' else 'MICROSOFT_ADS'
    account = env.get(prefix + ('_CUSTOMER_ID' if channel == 'google' else '_ACCOUNT_ID'), '').replace('-', '')
    if account != str(expected_account) or not re.fullmatch(r'\d{1,20}', account):
        return {'status': 'blocked', 'reason': 'CONFIGURED_ACCOUNT_MISMATCH', 'writes_performed': False}
    required = [prefix + '_DEVELOPER_TOKEN']
    if channel == 'microsoft':
        required += ['MICROSOFT_ADS_CUSTOMER_ID']
    elif not env.get('GOOGLE_ADS_ACCESS_TOKEN'):
        required += ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN']
    from .microsoft_auth import access_token, missing_auth
    missing = [key for key in required if not env.get(key)] + (missing_auth(env) if channel == 'microsoft' else [])
    if missing:
        return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
    if env.get('PILOT_SEARCH_STOP_WRITES_ENABLED') != 'true':
        return {'status': 'disabled', 'reason': 'SEARCH_STOP_WRITE_NOT_ENABLED', 'writes_performed': False}
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
    attempted = False
    try:
        token = await access_token(env, client) if channel == 'microsoft' else env.get(prefix + '_ACCESS_TOKEN')
        if not token:
            auth = await _bounded_json(client, 'https://oauth2.googleapis.com/token', data={
                'grant_type': 'refresh_token', 'client_id': env['GOOGLE_ADS_CLIENT_ID'],
                'client_secret': env['GOOGLE_ADS_CLIENT_SECRET'], 'refresh_token': env['GOOGLE_ADS_REFRESH_TOKEN']})
            token = auth['access_token']
        headers = {'Authorization': 'Bearer ' + token}
        if channel == 'google':
            version = env.get('GOOGLE_ADS_API_VERSION', 'v26')
            if not re.fullmatch(r'v\d{1,3}', version) or not re.fullmatch(r'\d{10}', account):
                raise ValueError('GOOGLE_ACCOUNT_OR_VERSION_INVALID')
            headers['developer-token'] = env['GOOGLE_ADS_DEVELOPER_TOKEN']
            manager = env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace('-', '')
            if manager:
                if not re.fullmatch(r'\d{10}', manager):
                    raise ValueError('GOOGLE_MANAGER_INVALID')
                headers['login-customer-id'] = manager
            base = f'https://googleads.googleapis.com/{version}/customers/{account}/'
            request = {'partialFailure': False, 'operations': [{'updateMask': 'status', 'update': {
                'resourceName': f'customers/{account}/campaigns/{campaign_id}', 'status': 'PAUSED'}}]}
            attempted = True
            result = await _bounded_json(client, base + 'campaigns:mutate', headers=headers, json=request)
            if result.get('partialFailureError') or result.get('error'):
                raise ValueError('PAUSE_NOT_CONFIRMED')
            rows = await _bounded_json(client, base + 'googleAds:searchStream', headers=headers,
                json={'query': f'SELECT campaign.id,campaign.status FROM campaign WHERE campaign.id = {campaign_id}'})
            states = [r['campaign'] for c in rows for r in c.get('results', [])]
            confirmed = len(states) == 1 and str(states[0]['id']) == str(campaign_id) and states[0]['status'] == 'PAUSED'
        else:
            customer = env['MICROSOFT_ADS_CUSTOMER_ID']
            if not re.fullmatch(r'\d{1,20}', customer):
                raise ValueError('MICROSOFT_CUSTOMER_INVALID')
            headers.update(DeveloperToken=env['MICROSOFT_ADS_DEVELOPER_TOKEN'], CustomerAccountId=account, CustomerId=customer)
            base = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns'
            attempted = True
            # UpdateCampaigns is PUT; _bounded_json is deliberately POST-only.
            async with client.stream('PUT', base, headers=headers, json={'AccountId': int(account),
                    'Campaigns': [{'Id': int(campaign_id), 'Status': 'Paused'}]}, follow_redirects=False) as reply:
                reply.raise_for_status()
                body = bytearray()
                async for chunk in reply.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2 * 1024 * 1024:
                        raise ValueError('PROVIDER_RESPONSE_SIZE_LIMIT')
            import json
            result = json.loads(body)
            if result.get('PartialErrors'):
                raise ValueError('PAUSE_NOT_CONFIRMED')
            result = await _bounded_json(client, base + '/QueryByAccountId', headers=headers,
                                        json={'AccountId': int(account), 'CampaignType': 'Search'})
            states = [r for r in result.get('Campaigns', []) if str(r.get('Id')) == str(campaign_id)]
            confirmed = len(states) == 1 and states[0].get('Status') == 'Paused'
        return {'status': 'paused_confirmed' if confirmed else 'pause_unconfirmed', 'channel': channel,
                'account_id': account, 'campaign_id': str(campaign_id), 'writes_performed': True,
                'budget_increase_authorized': False, 'campaigns_created': 0}
    except (ValueError, TypeError, KeyError, AttributeError, IndexError, httpx.HTTPError) as exc:
        return {'status': 'pause_unconfirmed', 'error_type': type(exc).__name__,
                'writes_performed': attempted, 'campaigns_created': 0, 'budget_increase_authorized': False}
    finally:
        if own:
            await client.aclose()
