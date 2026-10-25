"""Official Google and Microsoft account readers. No campaign mutation endpoints."""
from __future__ import annotations

import os
import re

import httpx

GOOGLE_QUERY = '''SELECT campaign.id,campaign.name,campaign.status,metrics.impressions,metrics.clicks,
metrics.cost_micros,metrics.conversions,metrics.conversions_value
FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != 'REMOVED' LIMIT 100'''


async def _bounded_json(client, url, **kwargs):
    async with client.stream('POST', url, follow_redirects=False, **kwargs) as response:
        response.raise_for_status()
        body = bytearray()
        async for part in response.aiter_bytes():
            body.extend(part)
            if len(body) > 2 * 1024 * 1024:
                raise ValueError('PROVIDER_RESPONSE_SIZE_LIMIT')
    import json
    return json.loads(body)


async def read_google(*, env=None, client=None):
    env = os.environ if env is None else env
    required = ['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_DEVELOPER_TOKEN']
    missing = [key for key in required if not env.get(key)]
    direct = env.get('GOOGLE_ADS_ACCESS_TOKEN')
    if not direct:
        missing.extend(key for key in ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'] if not env.get(key))
    if missing:
        return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
    account = env['GOOGLE_ADS_CUSTOMER_ID'].replace('-', '')
    version = env.get('GOOGLE_ADS_API_VERSION', 'v26')
    manager = env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace('-', '')
    if not re.fullmatch(r'\d{10}', account) or not re.fullmatch(r'v\d{1,3}', version) or (manager and not re.fullmatch(r'\d{10}', manager)):
        return {'status': 'blocked', 'reason': 'GOOGLE_ADS_ACCOUNT_OR_VERSION_INVALID', 'writes_performed': False}
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
    try:
        token = direct
        if not token:
            auth = await _bounded_json(client, 'https://oauth2.googleapis.com/token', data={
                'grant_type': 'refresh_token', 'client_id': env['GOOGLE_ADS_CLIENT_ID'],
                'client_secret': env['GOOGLE_ADS_CLIENT_SECRET'], 'refresh_token': env['GOOGLE_ADS_REFRESH_TOKEN']})
            token = auth['access_token']
        headers = {'Authorization': 'Bearer ' + token, 'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']}
        if manager:
            headers['login-customer-id'] = manager
        base = f'https://googleads.googleapis.com/{version}/customers/{account}/googleAds:searchStream'
        identity = await _bounded_json(client, base, headers=headers,
            json={'query': 'SELECT customer.id,customer.currency_code,customer.time_zone FROM customer LIMIT 1'})
        customer = identity[0]['results'][0]['customer']
        if str(customer['id']) != account:
            raise ValueError('GOOGLE_ADS_ACCOUNT_MISMATCH')
        result = await _bounded_json(client, base, headers=headers, json={'query': GOOGLE_QUERY})
        rows = []
        for chunk in result:
            for record in chunk.get('results', []):
                campaign, metrics = record['campaign'], record['metrics']
                rows.append({'id': str(campaign['id']), 'name': str(campaign.get('name', ''))[:200],
                    'status': campaign['status'], 'cost_micros': str(metrics.get('costMicros', '0')),
                    'impressions': str(metrics.get('impressions', '0')), 'clicks': str(metrics.get('clicks', '0')),
                    'reported_conversions': str(metrics.get('conversions', '0')),
                    'reported_conversion_value': str(metrics.get('conversionsValue', '0'))})
        if len(rows) > 100:
            raise ValueError('GOOGLE_ADS_REPORT_ROW_LIMIT')
        return {'status': 'observed', 'account_id': account, 'currency': customer['currencyCode'],
                'account_timezone': customer['timeZone'], 'window': 'LAST_7_DAYS_ACCOUNT_TIMEZONE',
                'campaigns': rows, 'read_only': True, 'writes_performed': False,
                'conversions_are_not_verified_purchases': True, 'net_profit_verified': False,
                'additional_spend_authorized': False}
    except (ValueError, TypeError, KeyError, IndexError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()


async def read_microsoft(*, env=None, client=None):
    env = os.environ if env is None else env
    required = ['MICROSOFT_ADS_ACCOUNT_ID', 'MICROSOFT_ADS_CUSTOMER_ID',
                'MICROSOFT_ADS_DEVELOPER_TOKEN', 'MICROSOFT_ADS_ACCESS_TOKEN']
    missing = [key for key in required if not env.get(key)]
    if missing:
        return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
    if any(not re.fullmatch(r'\d{1,20}', env[key]) for key in required[:2]):
        return {'status': 'blocked', 'reason': 'MICROSOFT_ADS_ACCOUNT_ID_INVALID', 'writes_performed': False}
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
    try:
        response = await _bounded_json(client,
            'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId',
            headers={'Authorization': 'Bearer ' + env['MICROSOFT_ADS_ACCESS_TOKEN'],
                'DeveloperToken': env['MICROSOFT_ADS_DEVELOPER_TOKEN'],
                'CustomerAccountId': env['MICROSOFT_ADS_ACCOUNT_ID'], 'CustomerId': env['MICROSOFT_ADS_CUSTOMER_ID']},
            json={'AccountId': int(env['MICROSOFT_ADS_ACCOUNT_ID']), 'CampaignType': 'Search'})
        if not isinstance(response, dict) or 'Campaigns' not in response:
            raise ValueError('MICROSOFT_CAMPAIGN_RESPONSE_UNCONFIRMED')
        campaigns = response.get('Campaigns') or []
        if not isinstance(campaigns, list) or len(campaigns) > 500:
            raise ValueError('MICROSOFT_REPORT_INVALID')
        return {'status': 'observed', 'account_id': env['MICROSOFT_ADS_ACCOUNT_ID'],
            'campaigns': [{'id': str(row['Id']), 'name': str(row.get('Name', ''))[:200],
                           'status': row.get('Status', 'Unknown')} for row in campaigns],
            'evidence_level': 'campaign_inventory_only', 'performance_metrics_available': False,
            'read_only': True, 'writes_performed': False, 'additional_spend_authorized': False}
    except (ValueError, TypeError, KeyError, httpx.HTTPError) as exc:
        return {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()


def connection_requirements(*, env=None):
    """Names-only readiness. Merchant credentials do not grant Ads API access."""
    env = os.environ if env is None else env
    google = ['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_DEVELOPER_TOKEN']
    if not env.get('GOOGLE_ADS_ACCESS_TOKEN'):
        google += ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN']
    microsoft = ['MICROSOFT_ADS_ACCOUNT_ID', 'MICROSOFT_ADS_CUSTOMER_ID',
                 'MICROSOFT_ADS_DEVELOPER_TOKEN', 'MICROSOFT_ADS_ACCESS_TOKEN']
    return {'channels': {name: {
        'missing_settings': [key for key in keys if not env.get(key)],
        'credentials_present': all(bool(env.get(key)) for key in keys),
        'live_connection_verified': False,
        'capabilities': capabilities,
    } for name, keys, capabilities in (
        ('google', google, ['inventory_read', 'metrics_read', 'validate_only_campaign_bundle']),
        ('microsoft', microsoft, ['inventory_read', 'offline_campaign_templates']))},
        'campaign_write_transport_complete': False, 'stop_only_transport_implemented': True, 'paid_activation_authorized': False,
        'authorized_spend_eur': 0, 'merchant_credentials_are_not_ads_credentials': True}
