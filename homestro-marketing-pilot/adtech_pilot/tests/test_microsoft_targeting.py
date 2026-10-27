import json
import unittest

import httpx
from adtech_pilot.microsoft_targeting import (
    SETTING,
    country_locations,
    targeting_readback,
    targeting_request,
)


class MicrosoftTargetingTests(unittest.IsolatedAsyncioTestCase):
    def test_country_ids_are_exact_setup_data_not_guessed_from_product_names(self):
        self.assertIsNone(country_locations({}))
        for value in ('{}', '{"DE":"101","AT":"101"}', '{"DE":101,"AT":102}',
                      '{"DE":"101","AT":"102","US":"103"}', '{"DE":"0","AT":"102"}'):
            with self.assertRaises(ValueError):
                country_locations({SETTING: value})
        locations = country_locations({SETTING: '{"DE":"101","AT":"102"}'})
        body = targeting_request('42', locations)
        self.assertEqual(body['CriterionType'], 'Targets')
        self.assertEqual([r['CampaignId'] for r in body['CampaignCriterions']], [42, 42, 42])
        self.assertEqual(body['CampaignCriterions'][0]['Criterion']['IntentOption'], 'PeopleIn')
        self.assertNotIn('Enabled', json.dumps(body))

    async def test_independent_readback_rejects_wrong_intent_language_country_or_override(self):
        for mode in ('ok', 'intent', 'language', 'country', 'override', 'missing'):
            def handle(request):
                self.assertEqual(request.method, 'POST')
                self.assertTrue(request.url.path.endswith('/QueryByIds'))
                body = json.loads(request.content)
                if request.url.path.endswith('CampaignCriterions/QueryByIds'):
                    if body['CriterionType'] == 'Location':
                        criteria = [{'Type': 'LocationCriterion', 'LocationId': n} for n in (101, 103 if mode == 'country' else 102)]
                    else:
                        criteria = [{'Type': 'LocationIntentCriterion', 'IntentOption': 'PeopleInOrSearchingForOrViewingPages' if mode == 'intent' else 'PeopleIn'}]
                    return httpx.Response(200, json={'CampaignCriterions': [{'CampaignId': 42,
                        'Type': 'BiddableCampaignCriterion', 'Status': 'Active', 'Criterion': c} for c in criteria]})
                if request.url.path.endswith('AdGroups/QueryByIds'):
                    return httpx.Response(200, json={'AdGroups': [{'Id': 43, 'Status': 'Paused', 'Language': 'English' if mode == 'language' else 'German'}]})
                return httpx.Response(200, json={} if mode == 'missing' else
                    {'AdGroupCriterions': [{'Criterion': {'Type': 'LocationCriterion'}}] if mode == 'override' else []})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                kwargs = {'headers': {}, 'campaign_id': '42', 'locations': {'DE': '101', 'AT': '102'},
                    'campaign': {'Status': 'Paused', 'Languages': ['German']}, 'ad_group_id': '43'}
                if mode == 'ok':
                    result = await targeting_readback(client, **kwargs)
                    self.assertTrue(result['targeting_policy_readback_verified'])
                    self.assertFalse(result['activation_authorized'])
                    self.assertFalse(result['country_identity_independently_verified'])
                else:
                    with self.assertRaises(ValueError):
                        await targeting_readback(client, **kwargs)
