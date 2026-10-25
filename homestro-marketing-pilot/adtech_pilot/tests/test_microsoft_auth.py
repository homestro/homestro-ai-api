import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.microsoft_auth import access_token


class MicrosoftAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_rotation_is_encrypted_and_reused_after_new_reader_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = PlanAuditStore(Path(directory) / 'audit.sqlite')
            env = {'MICROSOFT_ADS_CLIENT_ID': 'client', 'MICROSOFT_ADS_CLIENT_SECRET': 'private-client-secret',
                   'MICROSOFT_ADS_REFRESH_TOKEN': 'initial-refresh-secret', 'PILOT_ADMIN_KEY': 'k' * 40}
            now = datetime(2026, 10, 25, 12, tzinfo=UTC)
            calls = []
            def handle(request):
                self.assertEqual(str(request.url), 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
                values = parse_qs(request.content.decode())
                self.assertEqual(values['grant_type'], ['refresh_token'])
                self.assertEqual(values['refresh_token'], ['initial-refresh-secret' if not calls else 'rotated-refresh-secret'])
                calls.append(request)
                return httpx.Response(200, json={'access_token': 'private-access-token', 'refresh_token': 'rotated-refresh-secret', 'expires_in': 3600})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                first = await access_token(env, client, audit=audit, now=now)
                self.assertEqual(first, 'private-access-token')
                again = await access_token(env, client, audit=PlanAuditStore(Path(directory) / 'audit.sqlite'), now=now + timedelta(minutes=5))
                self.assertEqual(again, first)
                self.assertEqual(len(calls), 1)
                await access_token(env, client, audit=audit, now=now + timedelta(hours=1))
                self.assertEqual(len(calls), 2)
                with audit._connect() as db:
                    dump = '\n'.join(db.iterdump())
                for private in ('initial-refresh-secret', 'rotated-refresh-secret', 'private-access-token', 'private-client-secret'):
                    self.assertNotIn(private, dump)
                with self.assertRaisesRegex(ValueError, 'KEY_MISMATCH'):
                    await access_token({**env, 'PILOT_ADMIN_KEY': 'j' * 40}, client, audit=audit, now=now)

    async def test_existing_direct_token_needs_no_rotation_or_new_configuration(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network'))) as client:
            result = await access_token({'MICROSOFT_ADS_ACCESS_TOKEN': 'already-working'}, client)
        self.assertEqual(result, 'already-working')
