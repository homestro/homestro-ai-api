"""Persisted search campaign drafts and provider-specific, non-executing request compilers.

There is deliberately no production campaign mutation transport here. Google requests
are validateOnly, Microsoft requests are offline templates requiring resolved remote IDs.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlsplit

import httpx

from .content_engine import product_draft
from .search_channels import _bounded_json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def search_draft(raw, channel):
    if channel not in {'google', 'microsoft'}:
        raise ValueError('UNSUPPORTED_SEARCH_CHANNEL')
    source = product_draft(raw)
    title = source['seo']['h1']
    # Do not truncate a product name into a different product or invent a translation.
    words = re.findall(r'[\wäöüÄÖÜß-]+', title)
    keyword = ' '.join(words)
    if not keyword or len(keyword) > 80 or len(words) > 10:
        raise ValueError('SEARCH_KEYWORD_REVIEW_REQUIRED')
    headlines = ['Bei Homestro entdecken', 'Produktdetails ansehen', 'Varianten im Shop ansehen']
    if len(title) <= 30 and title not in headlines:
        headlines.insert(0, title)
    descriptions = ['Produktdetails und aktuelle Preise direkt im Homestro-Shop ansehen.',
                    'Vergleiche die Beschreibung und die verfügbaren Varianten im Shop.']
    identity = {'channel': channel, 'path': urlsplit(source['source_url']).path.rstrip('/')}
    value = {'id': fingerprint(identity), 'channel': channel, 'state': 'draft',
        'product_id': source['product_id'], 'source_url': source['source_url'],
        'source_revision': fingerprint(raw), 'campaign_name': 'Homestro Search ' + fingerprint(identity)[:16],
        'language': 'de', 'countries': ['DE', 'AT'], 'location_intent': 'physical_presence',
        'headlines': headlines, 'descriptions': descriptions,
        'keywords': [{'text': keyword, 'match_type': match} for match in ('EXACT', 'PHRASE')],
        'keyword_demand_verified': False, 'budget_authorized_eur': '0.00',
        'remote_campaign_id': None, 'publication_confirmed': False, 'writes_performed': False,
        'blockers': ['SEARCH_ACCOUNT_CONNECTION_REQUIRED', 'GERMAN_PRODUCT_NAME_AND_AD_COPY_REVIEW_REQUIRED',
                     'KEYWORD_DEMAND_NOT_VERIFIED', 'PURCHASE_MEASUREMENT_NOT_VERIFIED',
                     'ADDITIONAL_CHANNEL_SPEND_NOT_AUTHORIZED']}
    value['revision'] = fingerprint(value)
    return value


def verify_draft(draft):
    expected = fingerprint({key: value for key, value in draft.items() if key != 'revision'})
    if draft.get('revision') != expected or draft.get('state') != 'draft':
        raise ValueError('SEARCH_DRAFT_CHANGED_OR_NOT_DRAFT')
    parsed = urlsplit(draft['source_url'])
    if parsed.scheme != 'https' or parsed.hostname not in {'homestro.de', 'www.homestro.de'} or parsed.username or parsed.password:
        raise ValueError('UNTRUSTED_SEARCH_DESTINATION')
    if draft['countries'] != ['DE', 'AT'] or draft['budget_authorized_eur'] != '0.00':
        raise ValueError('SEARCH_DRAFT_POLICY_CHANGED')
    for field, minimum, maximum, length in [('headlines', 3, 15, 30), ('descriptions', 2, 4, 90)]:
        texts = draft[field]
        if not minimum <= len(texts) <= maximum or len(set(texts)) != len(texts):
            raise ValueError('SEARCH_TEXT_COUNT_INVALID')
        if any(not text.strip() or len(text) > length or any(c in text for c in '\r\n{}') for text in texts):
            raise ValueError('SEARCH_TEXT_INVALID')


def planned_budget(value):
    amount = Decimal(str(value))
    if not amount.is_finite() or amount <= 0 or amount > 5 or amount.as_tuple().exponent < -2:
        raise ValueError('SEARCH_PROPOSED_BUDGET_INVALID')
    return amount


def google_validation_request(draft, customer_id, *, proposed_daily_eur):
    """A complete dependent operation bundle, ALWAYS validation only, all ads paused.

    The proposed budget is a schema-validation fixture, not an approved ad budget.
    Location IDs must be resolved from provider constants before validation.
    """
    verify_draft(draft)
    if draft['channel'] != 'google' or not re.fullmatch(r'\d{10}', customer_id):
        raise ValueError('SEARCH_ACCOUNT_OR_CHANNEL_INVALID')
    amount = planned_budget(proposed_daily_eur)
    root = 'customers/' + customer_id
    budget, campaign, group = root + '/campaignBudgets/-1', root + '/campaigns/-2', root + '/adGroups/-3'
    operations = [
        {'campaignBudgetOperation': {'create': {'resourceName': budget, 'name': draft['campaign_name'] + ' budget',
            'amountMicros': str(int(amount * 1000000)), 'deliveryMethod': 'STANDARD', 'explicitlyShared': False}}},
        {'campaignOperation': {'create': {'resourceName': campaign, 'name': draft['campaign_name'],
            'status': 'PAUSED', 'advertisingChannelType': 'SEARCH', 'campaignBudget': budget,
            'manualCpc': {}, 'containsEuPoliticalAdvertising': 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            'networkSettings': {'targetGoogleSearch': True, 'targetSearchNetwork': False,
                                'targetContentNetwork': False, 'targetPartnerSearchNetwork': False},
            'geoTargetTypeSetting': {'positiveGeoTargetType': 'PRESENCE', 'negativeGeoTargetType': 'PRESENCE'}}}},
        {'adGroupOperation': {'create': {'resourceName': group, 'campaign': campaign,
            'name': draft['campaign_name'] + ' product', 'status': 'PAUSED', 'type': 'SEARCH_STANDARD', 'cpcBidMicros': '100000'}}},
        {'adGroupAdOperation': {'create': {'adGroup': group, 'status': 'PAUSED', 'ad': {
            'finalUrls': [draft['source_url']], 'responsiveSearchAd': {
                'headlines': [{'text': text} for text in draft['headlines']],
                'descriptions': [{'text': text} for text in draft['descriptions']]}}}}},
    ]
    operations.extend({'adGroupCriterionOperation': {'create': {'adGroup': group, 'status': 'PAUSED',
        'keyword': {'text': row['text'], 'matchType': row['match_type']}}}} for row in draft['keywords'])
    return {'validateOnly': True, 'partialFailure': False, 'mutateOperations': operations}


def bind_google_targets(request, *, locations, german_language):
    """Bind exact active provider lookups; never infer geographic IDs from a product."""
    if set(locations) != {'DE', 'AT'} or any(not re.fullmatch(r'geoTargetConstants/\d+', str(x)) for x in locations.values()):
        raise ValueError('VERIFIED_DE_AT_GEO_CONSTANTS_REQUIRED')
    if not re.fullmatch(r'languageConstants/\d+', str(german_language)):
        raise ValueError('VERIFIED_GERMAN_LANGUAGE_CONSTANT_REQUIRED')
    result = json.loads(json.dumps(request))
    if result.get('validateOnly') is not True:
        raise ValueError('VALIDATION_ONLY_REQUIRED')
    campaign = result['mutateOperations'][1]['campaignOperation']['create']['resourceName']
    for resource in locations.values():
        result['mutateOperations'].append({'campaignCriterionOperation': {'create': {
            'campaign': campaign, 'location': {'geoTargetConstant': resource}}}})
    result['mutateOperations'].append({'campaignCriterionOperation': {'create': {
        'campaign': campaign, 'language': {'languageConstant': german_language}}}})
    return result


def microsoft_request_templates(draft, account_id, *, proposed_daily_eur):
    """Offline API request bodies; $ IDs are explicitly unresolved dependencies.

    Microsoft lacks Google's validateOnly mutation mode. No request is transmitted.
    """
    verify_draft(draft)
    if draft['channel'] != 'microsoft' or not re.fullmatch(r'\d{1,20}', account_id):
        raise ValueError('SEARCH_ACCOUNT_OR_CHANNEL_INVALID')
    amount = planned_budget(proposed_daily_eur)
    def text_assets(values):
        return [{'Asset': {'Type': 'TextAsset', 'Text': value}} for value in values]
    return {'mode': 'offline_dependency_templates', 'ready_to_submit': False, 'writes_performed': False,
        'unresolved': ['CAMPAIGN_ID', 'AD_GROUP_ID', 'VERIFIED_DE_AT_LOCATION_IDS', 'LOCATION_INTENT_CRITERION'],
        'requests': [
            {'operation': 'AddCampaigns', 'body': {'AccountId': int(account_id), 'Campaigns': [{
                'Name': draft['campaign_name'], 'CampaignType': 'Search', 'Status': 'Paused',
                'DailyBudget': float(amount), 'BudgetType': 'DailyBudgetStandard', 'Languages': ['German'],
                'BiddingScheme': {'Type': 'MaxClicks', 'MaxCpc': {'Amount': 0.1}}}]}},
            {'operation': 'AddAdGroups', 'body': {'CampaignId': '$CAMPAIGN_ID', 'AdGroups': [{
                'Name': draft['campaign_name'] + ' product', 'Status': 'Paused', 'AdGroupType': 'SearchStandard',
                'Language': 'German', 'CpcBid': {'Amount': 0.1}, 'Network': 'OwnedAndOperatedOnly'}]}},
            {'operation': 'AddAds', 'body': {'AdGroupId': '$AD_GROUP_ID', 'Ads': [{
                'Type': 'ResponsiveSearch', 'Status': 'Paused', 'FinalUrls': [draft['source_url']],
                'Headlines': text_assets(draft['headlines']), 'Descriptions': text_assets(draft['descriptions'])}]}},
            {'operation': 'AddKeywords', 'body': {'AdGroupId': '$AD_GROUP_ID', 'Keywords': [{
                'Text': row['text'], 'MatchType': row['match_type'].title(), 'Status': 'Paused'} for row in draft['keywords']]}},
        ]}


async def validate_google_draft(draft, *, proposed_daily_eur, env=None, client=None, include_request=False):
    """Official provider validation, without persisting any Google campaign or budget."""
    env = os.environ if env is None else env
    if env.get('GOOGLE_ADS_VALIDATE_ONLY_ENABLED') != 'true':
        return {'status': 'disabled', 'reason': 'GOOGLE_VALIDATION_NOT_ENABLED', 'writes_performed': False}
    missing = [name for name in ('GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_DEVELOPER_TOKEN') if not env.get(name)]
    if not env.get('GOOGLE_ADS_ACCESS_TOKEN'):
        missing.extend(name for name in ('GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN') if not env.get(name))
    if missing:
        return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
    account = env['GOOGLE_ADS_CUSTOMER_ID'].replace('-', '')
    version = env.get('GOOGLE_ADS_API_VERSION', 'v26')
    manager = env.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace('-', '')
    if not re.fullmatch(r'v\d{1,3}', version) or manager and not re.fullmatch(r'\d{10}', manager):
        raise ValueError('SEARCH_ACCOUNT_OR_VERSION_INVALID')
    request = google_validation_request(draft, account, proposed_daily_eur=proposed_daily_eur)
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)
    try:
        token = env.get('GOOGLE_ADS_ACCESS_TOKEN')
        if not token:
            auth = await _bounded_json(client, 'https://oauth2.googleapis.com/token', data={
                'grant_type': 'refresh_token', 'client_id': env['GOOGLE_ADS_CLIENT_ID'],
                'client_secret': env['GOOGLE_ADS_CLIENT_SECRET'], 'refresh_token': env['GOOGLE_ADS_REFRESH_TOKEN']})
            token = auth['access_token']
        headers = {'Authorization': 'Bearer ' + token, 'developer-token': env['GOOGLE_ADS_DEVELOPER_TOKEN']}
        if manager:
            headers['login-customer-id'] = manager
        base = f'https://googleads.googleapis.com/{version}/customers/{account}/googleAds:'

        async def query(text):
            chunks = await _bounded_json(client, base + 'searchStream', headers=headers, json={'query': text})
            return [row for chunk in chunks for row in chunk.get('results', [])]

        customer = (await query('SELECT customer.id,customer.currency_code FROM customer LIMIT 1'))[0]['customer']
        if str(customer['id']) != account or customer.get('currencyCode') != 'EUR':
            raise ValueError('SEARCH_CUSTOMER_OR_CURRENCY_MISMATCH')
        rows = await query("SELECT geo_target_constant.resource_name,geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.country_code IN ('DE','AT') AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'")
        if len(rows) != 2:
            raise ValueError('VERIFIED_DE_AT_GEO_CONSTANTS_REQUIRED')
        locations = {row['geoTargetConstant']['countryCode']: row['geoTargetConstant']['resourceName'] for row in rows}
        rows = await query("SELECT language_constant.resource_name,language_constant.code FROM language_constant WHERE language_constant.code = 'de'")
        if len(rows) != 1 or rows[0]['languageConstant']['code'] != 'de':
            raise ValueError('VERIFIED_GERMAN_LANGUAGE_CONSTANT_REQUIRED')
        request = bind_google_targets(request, locations=locations, german_language=rows[0]['languageConstant']['resourceName'])
        # Caller cannot supply or disable validateOnly. No non-validation writer exists.
        reply = await _bounded_json(client, base + 'mutate', headers=headers, json=request)
        if not isinstance(reply, dict) or reply.get('error') or reply.get('partialFailureError') or reply.get('mutateOperationResponses'):
            raise ValueError('GOOGLE_VALIDATION_RESPONSE_UNCONFIRMED')
        return {**({'validated_request': request} if include_request else {}), 'status': 'provider_validated_only', 'draft_id': draft['id'], 'revision': draft['revision'],
            'account_id': account, 'provider_validation_only': True, 'operation_count': len(request['mutateOperations']),
            'remote_campaigns_created': 0, 'writes_performed': False, 'authorized_spend_eur': 0}
    except (ValueError, TypeError, KeyError, IndexError, httpx.HTTPError) as exc:
        return {'status': 'validation_unconfirmed', 'error_type': type(exc).__name__, 'writes_performed': False}
    finally:
        if own:
            await client.aclose()


class SearchCampaignDrafts:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_search_drafts(id TEXT PRIMARY KEY, revision TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)')

    def reconcile(self, products, *, now=None):
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        seen, skipped = set(), 0
        with closing(self.audit._connect()) as db, db:
            for product in products:
                for channel in ('google', 'microsoft'):
                    try:
                        draft = search_draft(product, channel)
                    except (ValueError, TypeError, KeyError):
                        skipped += 1
                        continue
                    if draft['id'] in seen:
                        continue
                    seen.add(draft['id'])
                    db.execute('INSERT INTO pilot_search_drafts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,expires_at=excluded.expires_at,payload=excluded.payload',
                        (draft['id'], draft['revision'], (now + timedelta(hours=6)).isoformat(), json.dumps(draft, ensure_ascii=False)))
            for key, in db.execute('SELECT id FROM pilot_search_drafts').fetchall():
                if key not in seen:
                    db.execute('DELETE FROM pilot_search_drafts WHERE id=?', (key,))
        return {'status': 'drafted', 'draft_count': len(seen), 'invalid_channel_candidates': skipped,
                'remote_campaigns_created': 0, 'writes_performed': False, 'authorized_spend_eur': 0}

    def list(self, *, now=None):
        at = (now or datetime.now(UTC)).isoformat()
        with closing(self.audit._connect()) as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM pilot_search_drafts WHERE expires_at>? ORDER BY id', (at,))]
