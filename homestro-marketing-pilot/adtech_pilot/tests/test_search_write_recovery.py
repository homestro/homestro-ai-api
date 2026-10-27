import json
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.search_write_recovery import SearchWriteRecovery, campaign_identity


class SearchWriteRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.worker = SearchWriteRecovery(self.audit)
        self.now = datetime(2026, 10, 25, 20, tzinfo=UTC)
        self.google = {'GOOGLE_ADS_CUSTOMER_ID': '1234567890', 'GOOGLE_ADS_ACCESS_TOKEN': 'existing-google',
                       'GOOGLE_ADS_DEVELOPER_TOKEN': 'dev'}
        self.microsoft = {'MICROSOFT_ADS_ACCOUNT_ID': '123', 'MICROSOFT_ADS_CUSTOMER_ID': '456',
                          'MICROSOFT_ADS_ACCESS_TOKEN': 'existing-ms', 'MICROSOFT_ADS_DEVELOPER_TOKEN': 'dev'}
        self.requests = []

    def seed(self, channel, *, draft_id='a' * 64, campaign_id='77', account=None, steps=None):
        account = account or ('1234567890' if channel == 'google' else '123')
        identity = account + ':' + draft_id
        intent = {'draft_id': draft_id, 'account_id': account, 'campaign_id': campaign_id,
                  'revision': 'b' * 64, 'status': 'write_uncertain', 'steps': steps or {}}
        with closing(self.audit._connect()) as db, db:
            db.execute(f'CREATE TABLE IF NOT EXISTS pilot_{channel}_writes(identity TEXT PRIMARY KEY,payload TEXT NOT NULL)')
            db.execute(f'INSERT INTO pilot_{channel}_writes VALUES (?,?)', (identity, json.dumps(intent)))
        return identity, intent

    def originals(self, channel):
        with closing(self.audit._connect()) as db:
            return db.execute(f'SELECT identity,payload FROM pilot_{channel}_writes ORDER BY identity').fetchall()

    def google_handle(self, request):
        self.requests.append(request)
        self.assertNotIn('mutate', str(request.url))
        self.assertTrue(str(request.url).endswith('/googleAds:searchStream'))
        query = json.loads(request.content)['query']
        self.assertTrue(query.startswith('SELECT '))
        if 'FROM customer ' in query:
            return httpx.Response(200, json=[{'results': [{'customer': {'id': '1234567890', 'currencyCode': 'EUR'}}]}])
        return httpx.Response(200, json=[{'results': [{'campaign': {'id': '77', 'name': 'Homestro Search ' + 'a' * 16, 'status': 'PAUSED'}}]}])

    async def test_no_intents_makes_zero_network_and_creates_no_writer_tables(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network forbidden'))) as client:
            result = await self.worker.cycle(env={}, client=client, now=self.now)
        self.assertEqual(result['status'], 'no_intents')
        with closing(self.audit._connect()) as db:
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='pilot_google_writes'").fetchone())

    async def test_missing_accounts_are_reported_without_requests_or_original_mutation(self):
        self.seed('google')
        before = self.originals('google')
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network forbidden'))) as client:
            result = await self.worker.cycle(env={}, client=client, now=self.now)
        self.assertEqual(result['channels']['google']['status'], 'not_configured')
        self.assertEqual(self.originals('google'), before)

    async def test_google_exact_id_name_account_readback_is_separate_from_full_bundle_and_spend(self):
        identity, _ = self.seed('google')
        before = self.originals('google')
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.google_handle)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        row = result['channels']['google']['results'][0]
        self.assertTrue(row['campaign_paused_verified'])
        self.assertFalse(row['full_bundle_verified'])
        self.assertFalse(row['ad_delivery_verified'])
        self.assertFalse(row['writes_performed'])
        self.assertFalse(row['activation_authorized'])
        self.assertEqual(self.originals('google'), before)
        with closing(self.audit._connect()) as db:
            persisted = json.loads(db.execute('SELECT payload FROM pilot_search_write_readbacks WHERE identity=?', (identity,)).fetchone()[0])
        self.assertEqual(persisted['observed_at'], self.now.isoformat())
        self.assertNotIn('existing-google', json.dumps(result))

    async def test_unknown_id_and_duplicate_names_never_adopt_campaign_ownership(self):
        self.seed('google', campaign_id=None)
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.google_handle)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        row = result['channels']['google']['results'][0]
        self.assertEqual(row['status'], 'identity_unconfirmed')
        self.assertFalse(row['campaign_paused_verified'])
        self.assertIsNone(json.loads(self.originals('google')[0][1])['campaign_id'])
        def duplicate(request):
            response = self.google_handle(request)
            if 'FROM campaign ' in json.loads(request.content)['query']:
                response = httpx.Response(200, json=[{'results': response.json()[0]['results'] * 2}])
            return response
        async with httpx.AsyncClient(transport=httpx.MockTransport(duplicate)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        self.assertEqual(result['channels']['google']['results'][0]['status'], 'ambiguous')

    async def test_foreign_account_and_mismatched_name_fail_closed(self):
        self.seed('google')
        def mismatch(request):
            response = self.google_handle(request)
            data = response.json()
            if 'FROM campaign ' in json.loads(request.content)['query']:
                data[0]['results'][0]['campaign']['name'] = 'Someone else'
            return httpx.Response(200, json=data)
        async with httpx.AsyncClient(transport=httpx.MockTransport(mismatch)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        self.assertEqual(result['channels']['google']['results'][0]['status'], 'identity_mismatch')
        self.requests.clear()
        foreign = {**self.google, 'GOOGLE_ADS_CUSTOMER_ID': '9999999999'}
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('no foreign request'))) as client:
            result = await self.worker.cycle(env=foreign, client=client, now=self.now)
        self.assertFalse(result['channels']['google']['results'][0]['campaign_paused_verified'])

    async def test_known_microsoft_step_id_recovers_readback_but_preserves_partial_child_intents(self):
        _, intent = self.seed('microsoft', campaign_id=None,
            steps={'Campaigns': {'state': 'response_received', 'ids': ['77']}, 'Ads': {'state': 'intent'}})
        before = self.originals('microsoft')
        def handle(request):
            self.requests.append(request)
            self.assertNotIn('/Campaigns', str(request.url).replace('/Campaigns/QueryByAccountId', ''))
            self.assertEqual(request.method, 'POST')
            if '/Account/Query' in str(request.url):
                return httpx.Response(200, json={'Account': {'Id': 123, 'CurrencyCode': 'EUR'}})
            self.assertTrue(str(request.url).endswith('/Campaigns/QueryByAccountId'))
            return httpx.Response(200, json={'Campaigns': [{'Id': 77, 'Name': 'Homestro Search ' + 'a' * 16, 'Status': 'Paused'}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await self.worker.cycle(env=self.microsoft, client=client, now=self.now)
        row = result['channels']['microsoft']['results'][0]
        self.assertTrue(row['campaign_paused_verified'])
        self.assertFalse(row['full_bundle_verified'])
        self.assertEqual(self.originals('microsoft'), before)
        self.assertEqual(intent['steps']['Ads']['state'], 'intent')
        self.assertNotIn('existing-ms', json.dumps(result))

    async def test_bad_intent_does_not_stop_following_valid_intent(self):
        self.seed('google', draft_id='0' * 64, account='0000000000')
        self.seed('google')
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.google_handle)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        rows = result['channels']['google']['results']
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['status'], 'unavailable')
        self.assertTrue(rows[1]['campaign_paused_verified'])
        self.assertEqual(len(self.requests), 2)

    async def test_batch_bound_and_rotation_survive_restart(self):
        for index in range(25):
            self.seed('google', draft_id=f'{index:064x}', campaign_id='77')
        before = self.originals('google')
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.google_handle)) as client:
            first = await self.worker.cycle(env=self.google, client=client, now=self.now)
            second = await SearchWriteRecovery(self.audit).cycle(env=self.google, client=client, now=self.now + timedelta(minutes=5))
        first_ids = {r['intent_identity'] for r in first['channels']['google']['results']}
        second_ids = {r['intent_identity'] for r in second['channels']['google']['results']}
        self.assertEqual(len(first_ids), 20)
        self.assertEqual(len(second_ids), 20)
        self.assertEqual(len(first_ids | second_ids), 25)
        self.assertEqual(self.originals('google'), before)

    async def test_provider_account_mismatch_is_never_campaign_proof_and_is_read_once(self):
        self.seed('google')
        self.seed('google', draft_id='b' * 64)
        def foreign(request):
            self.requests.append(request)
            return httpx.Response(200, json=[{'results': [{'customer': {'id': '9999999999', 'currencyCode': 'EUR'}}]}])
        async with httpx.AsyncClient(transport=httpx.MockTransport(foreign)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result['checked'], 2)
        self.assertTrue(all(not row['campaign_paused_verified'] for row in result['channels']['google']['results']))

    async def test_one_campaign_read_failure_does_not_stop_the_next_intent(self):
        self.seed('google', draft_id='a' * 64, campaign_id='77')
        self.seed('google', draft_id='b' * 64, campaign_id='88')
        def handle(request):
            query = json.loads(request.content)['query']
            if 'FROM customer ' in query:
                return self.google_handle(request)
            self.requests.append(request)
            if 'campaign.id = 77' in query:
                return httpx.Response(503, json={'error': 'private provider text'})
            return httpx.Response(200, json=[{'results': [{'campaign': {
                'id': '88', 'name': 'Homestro Search ' + 'b' * 16, 'status': 'PAUSED'}}]}])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await self.worker.cycle(env=self.google, client=client, now=self.now)
        rows = result['channels']['google']['results']
        self.assertEqual(rows[0]['status'], 'unavailable')
        self.assertTrue(rows[1]['campaign_paused_verified'])
        self.assertEqual(len(self.requests), 3)
        self.assertNotIn('private provider text', json.dumps(result))

    def test_conflicting_known_campaign_ids_are_not_reconciled_by_guess(self):
        with self.assertRaises(ValueError):
            campaign_identity('123:' + 'a' * 64, {'draft_id': 'a' * 64, 'account_id': '123',
                'campaign_id': '77', 'steps': {'Campaigns': {'ids': ['88']}}}, '123')
