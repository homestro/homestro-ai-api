import io
import json
import tempfile
import unittest
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from adtech_pilot.media_buyer import PlanAuditStore
from adtech_pilot.microsoft_reports import COLUMNS, MicrosoftReports, parse_report


def zipped(text):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('report.csv', text)
    return data.getvalue()


class MicrosoftReportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audit = PlanAuditStore(Path(self.tmp.name) / 'audit.sqlite')
        self.env = {'MICROSOFT_ADS_ACCOUNT_ID': '123', 'MICROSOFT_ADS_CUSTOMER_ID': '321',
                    'MICROSOFT_ADS_DEVELOPER_TOKEN': 'secret', 'MICROSOFT_ADS_ACCESS_TOKEN': 'token'}
        self.now = datetime(2026, 10, 25, 12, tzinfo=UTC)

    async def test_unconfigured_does_not_call_provider(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: self.fail('network'))) as client:
            result = await MicrosoftReports(self.audit).cycle(env={}, client=client)
        self.assertEqual(result['status'], 'not_configured')

    async def test_persistent_submit_poll_download_with_no_auth_on_download(self):
        calls = []
        def handle(request):
            calls.append(request)
            if request.url.path.endswith('/Submit'):
                body = json.loads(request.content)['ReportRequest']
                self.assertEqual(body['Scope']['AccountIds'], [123])
                self.assertEqual(body['Columns'], COLUMNS)
                return httpx.Response(200, json={'ReportRequestId': 'report-1'})
            if request.url.path.endswith('/Poll'):
                self.assertEqual(json.loads(request.content)['ReportRequestId'], 'report-1')
                return httpx.Response(200, json={'ReportRequestStatus': {'Status': 'Success',
                    'ReportDownloadUrl': 'https://reports.bingads.microsoft.com/data.zip?private-sas=secret'}})
            self.assertNotIn('authorization', request.headers)
            self.assertNotIn('developertoken', request.headers)
            return httpx.Response(200, content=zipped(','.join(COLUMNS) + '\n123,42,Existing,EUR,100,4,2.50,1,39.90\n'))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            first = await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now)
            self.assertEqual(first['status'], 'report_pending')
            self.assertEqual(len(calls), 1)
            cached = await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now + timedelta(seconds=20))
            self.assertEqual(cached['status'], 'report_pending')
            self.assertEqual(len(calls), 1)
            result = await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now + timedelta(minutes=2))
            self.assertEqual(result['status'], 'observed')
            self.assertEqual(result['campaigns'][0]['spend_eur'], '2.50')
            self.assertTrue(result['conversions_are_not_verified_purchases'])
            self.assertFalse(result['common_window_verified'])
            self.assertEqual(len(calls), 3)
            await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now + timedelta(minutes=3))
            self.assertEqual(len(calls), 3)
        with self.audit._connect() as db:
            dump = '\n'.join(db.iterdump())
        self.assertNotIn('private-sas', dump)
        self.assertNotIn('Bearer token', dump)

    def test_account_currency_duplicates_and_bad_numbers_are_rejected(self):
        for row in ('999,42,Existing,EUR,100,4,2.50,1,39.90', '123,42,Existing,USD,100,4,2.50,1,39.90',
                    '123,42,Existing,EUR,100,4,NaN,1,39.90', '123,42,Existing,EUR,1.5,4,2.50,1,39.90'):
            with self.assertRaises(ValueError):
                parse_report(zipped(','.join(COLUMNS) + '\n' + row + '\n'), '123')
        row = '123,42,Existing,EUR,100,4,2.50,1,39.90\n'
        with self.assertRaises(ValueError):
            parse_report(zipped(','.join(COLUMNS) + '\n' + row * 2), '123')

    def test_missing_conversion_values_preserve_spend_but_never_invent_zero_sales(self):
        rows = parse_report(zipped(','.join(COLUMNS) + '\n123,42,Existing,EUR,100,4,2.50,,--\n'), '123')
        self.assertEqual(rows[0]['spend_eur'], '2.50')
        self.assertIsNone(rows[0]['reported_conversions'])
        self.assertIsNone(rows[0]['reported_revenue_eur'])

    async def test_foreign_download_host_is_not_requested_and_cannot_become_metrics(self):
        def handle(request):
            if request.url.path.endswith('/Submit'):
                return httpx.Response(200, json={'ReportRequestId': 'report-1'})
            self.assertTrue(request.url.path.endswith('/Poll'))
            return httpx.Response(200, json={'ReportRequestStatus': {'Status': 'Success', 'ReportDownloadUrl': 'https://127.0.0.1/private'}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now)
            result = await MicrosoftReports(self.audit).cycle(env=self.env, client=client, now=self.now + timedelta(minutes=2))
        self.assertEqual(result['status'], 'unavailable')
        self.assertFalse(result['performance_metrics_available'])
