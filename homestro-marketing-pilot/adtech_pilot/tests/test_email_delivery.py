import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from adtech_pilot.email_delivery import EmailDelivery
from adtech_pilot.media_buyer import PlanAuditStore


class EmailDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audit = PlanAuditStore(Path(self.directory.name) / 'audit.sqlite')
        self.email = EmailDelivery(self.audit, secret='x' * 40)
        self.now = datetime.now(UTC)
        self.recipient = 'customer@example.test'
        self.env = {'PILOT_EMAIL_SEND_ENABLED': 'true', 'PILOT_EMAIL_FROM': 'shop@example.test',
                    'PILOT_SMTP_HOST': 'smtp.example.test', 'PILOT_PUBLIC_ORIGIN': 'https://pilot.example.test',
                    'PILOT_EMAIL_DAILY_LIMIT': '3'}
        self.input = {'recipient': self.recipient, 'subject': 'Produktdetails', 'body': 'Details bei Homestro.',
                      'campaign_id': 'reviewed-1', 'owner_authorized': True, 'env': self.env, 'now': self.now}
        self.messages = []
        outer = self
        class SMTP:
            def __init__(self, host, port, **kwargs):
                outer.assertEqual(port, 465)
                outer.assertIn('context', kwargs)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def send_message(self, message):
                outer.messages.append(message)
                return {}
        self.smtp = SMTP

    def consent(self):
        return self.email.consent(self.recipient, observed_at=(self.now - timedelta(minutes=1)).isoformat(),
                                  evidence_id='actual-double-opt-in-event-1', confirmed=True, now=self.now)

    async def test_no_consent_or_disabled_authority_cannot_send(self):
        self.assertEqual((await self.email.send(**self.input, smtp_factory=self.smtp))['status'], 'blocked')
        self.consent()
        self.assertEqual((await self.email.send(**{**self.input, 'owner_authorized': False}, smtp_factory=self.smtp))['status'], 'blocked')
        self.assertEqual((await self.email.send(**{**self.input, 'env': {}}, smtp_factory=self.smtp))['status'], 'blocked')
        self.assertEqual(self.messages, [])

    async def test_smtp_acceptance_and_list_unsubscribe_are_not_delivery_or_purchase(self):
        self.consent()
        result = await self.email.send(**self.input, smtp_factory=self.smtp)
        self.assertEqual(result['status'], 'accepted')
        self.assertFalse(result['delivery_verified'])
        self.assertFalse(result['purchase_verified'])
        self.assertIn('One-Click', str(self.messages[0]['List-Unsubscribe-Post']))
        self.assertIn('/email/unsubscribe/', str(self.messages[0]['List-Unsubscribe']))
        again = await EmailDelivery(self.audit, secret='x' * 40).send(**self.input, smtp_factory=self.smtp)
        self.assertFalse(again['repeat_submission'])
        self.assertEqual(len(self.messages), 1)
        self.assertNotIn(self.recipient.encode(), self.audit.database_path.read_bytes())

    async def test_unsubscribe_blocks_future_messages_and_old_consent_cannot_reactivate(self):
        key = self.consent()['recipient_key']
        self.email.unsubscribe(key, self.email.signature(key), now=self.now)
        self.consent()
        self.assertEqual((await self.email.send(**self.input, smtp_factory=self.smtp))['status'], 'blocked')
        self.assertEqual(self.messages, [])
        with self.assertRaises(ValueError):
            self.email.unsubscribe(key, 'forged')

    async def test_lost_smtp_response_never_replays_after_restart(self):
        self.consent()
        outer = self
        class LostSMTP(self.smtp):
            def send_message(self, message):
                outer.messages.append(message)
                raise ConnectionError('lost response')
        result = await self.email.send(**self.input, smtp_factory=LostSMTP)
        self.assertEqual(result['status'], 'uncertain')
        result = await EmailDelivery(self.audit, secret='x' * 40).send(**self.input, smtp_factory=self.smtp)
        self.assertEqual(result['status'], 'uncertain')
        self.assertEqual(len(self.messages), 1)

    async def test_recipient_frequency_limit_prevents_second_campaign_same_day(self):
        self.consent()
        await self.email.send(**self.input, smtp_factory=self.smtp)
        result = await self.email.send(**{**self.input, 'campaign_id': 'different', 'subject': 'Druha zprava'}, smtp_factory=self.smtp)
        self.assertEqual(result['reason'], 'DAILY_OR_RECIPIENT_FREQUENCY_LIMIT')
        self.assertEqual(len(self.messages), 1)

    async def test_newlines_in_subject_and_future_consent_are_rejected(self):
        self.consent()
        with self.assertRaises(ValueError):
            await self.email.send(**{**self.input, 'subject': 'Hello\r\nBcc: other@example.test'}, smtp_factory=self.smtp)
        with self.assertRaises(ValueError):
            self.email.consent(self.recipient, observed_at=(self.now + timedelta(hours=1)).isoformat(),
                               evidence_id='future', confirmed=True, now=self.now)
        self.assertEqual(self.messages, [])
