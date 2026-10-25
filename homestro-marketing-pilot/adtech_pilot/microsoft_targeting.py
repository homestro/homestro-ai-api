"""Exact DE/AT policy binding and independent Microsoft criterion readback.

Country IDs are account setup data, never inferred from names, product text or
Google IDs. Applying criteria cannot activate the parent paused campaign.
"""
from __future__ import annotations

import json
import re

from .search_channels import _bounded_json

BASE = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/'
SETTING = 'MICROSOFT_ADS_COUNTRY_LOCATION_IDS_JSON'


def country_locations(env):
    raw = env.get(SETTING)
    if not raw:
        return None
    locations = json.loads(raw)
    if (not isinstance(locations, dict) or set(locations) != {'DE', 'AT'}
        or any(not isinstance(v, str) or not re.fullmatch(r'[1-9]\d{0,18}', v) for v in locations.values())
        or len(set(locations.values())) != 2):
        raise ValueError('EXACT_DE_AT_COUNTRY_LOCATION_IDS_REQUIRED')
    return locations


def targeting_request(campaign_id, locations):
    if (not re.fullmatch(r'[1-9]\d{0,18}', str(campaign_id)) or set(locations) != {'DE', 'AT'}
        or any(not re.fullmatch(r'[1-9]\d{0,18}', str(v)) for v in locations.values())
        or len(set(map(str, locations.values()))) != 2):
        raise ValueError('EXACT_DE_AT_COUNTRY_LOCATION_IDS_REQUIRED')
    # Intent first: do not leave Microsoft's broader default in the request.
    criteria = [{'Type': 'LocationIntentCriterion', 'IntentOption': 'PeopleIn'}]
    criteria += [{'Type': 'LocationCriterion', 'LocationId': int(locations[country])} for country in ('DE', 'AT')]
    return {'CriterionType': 'Targets', 'CampaignCriterions': [
        {'Type': 'BiddableCampaignCriterion', 'CampaignId': int(campaign_id), 'Criterion': item}
        for item in criteria]}


async def targeting_readback(client, *, headers, campaign_id, locations, campaign, ad_group_id):
    expected = set(locations.values())
    rows = {}
    for kind in ('Location', 'LocationIntent'):
        reply = await _bounded_json(client, BASE + 'CampaignCriterions/QueryByIds', headers=headers,
            json={'CampaignId': int(campaign_id), 'CampaignCriterionIds': None, 'CriterionType': kind})
        if reply.get('PartialErrors') or not isinstance(reply.get('CampaignCriterions'), list):
            raise ValueError('MICROSOFT_TARGET_READBACK_UNCONFIRMED')
        rows[kind] = reply['CampaignCriterions']
    for group in rows.values():
        if len(group) > 3 or any(not isinstance(row, dict)
            or str(row.get('CampaignId')) != str(campaign_id)
            or row.get('Type') != 'BiddableCampaignCriterion' or row.get('Status') != 'Active' for row in group):
            raise ValueError('MICROSOFT_TARGET_READBACK_UNCONFIRMED')
    geo, intent = rows['Location'], rows['LocationIntent']
    if (len(geo) != 2 or {str(row.get('Criterion', {}).get('LocationId')) for row in geo} != expected
        or any(row.get('Criterion', {}).get('Type') not in {'Location', 'LocationCriterion'} for row in geo)
        or len(intent) != 1 or intent[0].get('Criterion', {}).get('Type') not in {'LocationIntent', 'LocationIntentCriterion'}
        or intent[0].get('Criterion', {}).get('IntentOption') != 'PeopleIn'
        or campaign.get('Languages') != ['German'] or campaign.get('Status') != 'Paused'):
        raise ValueError('MICROSOFT_TARGET_POLICY_MISMATCH')
    group_reply = await _bounded_json(client, BASE + 'AdGroups/QueryByIds', headers=headers,
        json={'CampaignId': int(campaign_id), 'AdGroupIds': [int(ad_group_id)]})
    groups = group_reply.get('AdGroups')
    if (group_reply.get('PartialErrors') or not isinstance(groups, list) or len(groups) != 1
        or not isinstance(groups[0], dict) or str(groups[0].get('Id')) != str(ad_group_id)
        or groups[0].get('Status') != 'Paused' or groups[0].get('Language') != 'German'):
        raise ValueError('MICROSOFT_AD_GROUP_LANGUAGE_UNCONFIRMED')
    for kind in ('Location', 'Radius'):
        reply = await _bounded_json(client, BASE + 'AdGroupCriterions/QueryByIds', headers=headers,
            json={'AdGroupId': int(ad_group_id), 'AdGroupCriterionIds': None, 'CriterionType': kind})
        # Any ad-group geographic criteria replace campaign targeting. Never infer inheritance.
        if reply.get('PartialErrors') or reply.get('AdGroupCriterions') != []:
            raise ValueError('MICROSOFT_AD_GROUP_GEO_OVERRIDE_PRESENT_OR_UNCONFIRMED')
    return {'configured_country_location_ids': locations, 'presence_only_confirmed': True,
            'german_campaign_language_confirmed': True, 'campaign_paused_confirmed': True,
            'targeting_policy_readback_verified': True, 'country_identity_source': SETTING,
            'country_identity_independently_verified': False, 'ad_group_override_readback_verified': True,
            'activation_authorized': False}
