"""Persistent Microsoft Advertising report submit/poll/download, without ad mutations."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import zipfile
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlsplit

import httpx

from .microsoft_auth import access_token, missing_auth
from .search_channels import _bounded_json

BASE = 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/'
COLUMNS = ['AccountId', 'CampaignId', 'CampaignName', 'CurrencyCode', 'Impressions', 'Clicks', 'Spend', 'Conversions', 'Revenue']
MAX_DOWNLOAD = 2 * 1024 * 1024
MAX_CSV = 8 * 1024 * 1024


def report_request(account):
    return {'ReportRequest': {'Type': 'CampaignPerformanceReportRequest', 'ReportName': 'Homestro campaign evidence',
        'Format': 'Csv', 'FormatVersion': '2.0', 'Aggregation': 'Summary', 'ExcludeColumnHeaders': False,
        'ExcludeReportHeader': True, 'ExcludeReportFooter': True, 'ReturnOnlyCompleteData': True,
        'Columns': COLUMNS, 'Scope': {'AccountIds': [int(account)]}, 'Time': {'PredefinedTime': 'LastSevenDays'}}}


def parse_report(data, account):
    """Never extract an archive; bound compressed and expanded input before reading."""
    if len(data) > MAX_DOWNLOAD:
        raise ValueError('MICROSOFT_DOWNLOAD_TOO_LARGE')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = archive.infolist()
        if len(files) != 1 or files[0].is_dir() or files[0].file_size > MAX_CSV or files[0].flag_bits & 1:
            raise ValueError('MICROSOFT_ARCHIVE_INVALID')
        with archive.open(files[0]) as stream:
            raw = stream.read(MAX_CSV + 1)
    if len(raw) > MAX_CSV:
        raise ValueError('MICROSOFT_CSV_TOO_LARGE')
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    if reader.fieldnames != COLUMNS:
        raise ValueError('MICROSOFT_REPORT_COLUMNS_INVALID')
    rows, seen = [], set()
    for row in reader:
        if len(rows) >= 500 or None in row or any(value is None for value in row.values()):
            raise ValueError('MICROSOFT_REPORT_ROWS_INVALID')
        if row['AccountId'] != account or row['CurrencyCode'] != 'EUR' or not re.fullmatch(r'\d{1,20}', row['CampaignId']):
            raise ValueError('MICROSOFT_REPORT_ACCOUNT_OR_CURRENCY_MISMATCH')
        if row['CampaignId'] in seen:
            raise ValueError('MICROSOFT_DUPLICATE_CAMPAIGN_SUMMARY')
        seen.add(row['CampaignId'])
        values: dict[str, str | None] = {}
        for name in ('Impressions', 'Clicks', 'Spend', 'Conversions', 'Revenue'):
            if name in {'Conversions', 'Revenue'} and row[name].strip() in {'', '--'}:
                values[name] = None
                continue
            number = Decimal(row[name])
            if not number.is_finite() or number < 0 or name in {'Impressions', 'Clicks'} and number != int(number):
                raise ValueError('MICROSOFT_REPORT_NUMBER_INVALID')
            values[name] = str(number)
        rows.append({'id': row['CampaignId'], 'name': row['CampaignName'][:200], 'currency': 'EUR',
            'impressions': values['Impressions'], 'clicks': values['Clicks'], 'spend_eur': values['Spend'],
            'reported_conversions': values['Conversions'], 'reported_revenue_eur': values['Revenue']})
    return rows


class MicrosoftReports:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_microsoft_reports (identity TEXT PRIMARY KEY,payload TEXT NOT NULL)')

    def load(self, identity):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT payload FROM pilot_microsoft_reports WHERE identity=?', (identity,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, identity, record):
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_microsoft_reports VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload',
                       (identity, json.dumps(record)))

    async def cycle(self, *, env=None, client=None, now=None):
        env = os.environ if env is None else env
        required = ['MICROSOFT_ADS_ACCOUNT_ID', 'MICROSOFT_ADS_CUSTOMER_ID', 'MICROSOFT_ADS_DEVELOPER_TOKEN']
        missing = [key for key in required if not env.get(key)] + missing_auth(env)
        if missing:
            return {'status': 'not_configured', 'missing_settings': missing, 'writes_performed': False}
        account, customer = env[required[0]], env[required[1]]
        if any(not re.fullmatch(r'\d{1,20}', value) for value in (account, customer)):
            return {'status': 'blocked', 'reason': 'MICROSOFT_ACCOUNT_INVALID', 'writes_performed': False}
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        identity = hashlib.sha256((account + ':' + customer).encode()).hexdigest()
        state = self.load(identity)
        if state and now < datetime.fromisoformat(state['next_check']):
            return state['public']
        # Reports expire after one day. Do not reuse an expired job or stale metrics.
        if state and now - datetime.fromisoformat(state['created_at']) >= timedelta(hours=23):
            state = None
        own = client is None
        client = client or httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)
        headers = {'DeveloperToken': env[required[2]],
                   'CustomerAccountId': account, 'CustomerId': customer}
        try:
            headers['Authorization'] = 'Bearer ' + await access_token(env, client, audit=self.audit, now=now)
            if not state or state['phase'] in {'complete', 'failed', 'submit_uncertain'}:
                state = {'phase': 'submit_uncertain', 'created_at': now.isoformat(), 'next_check': (now + timedelta(minutes=15)).isoformat(),
                         'public': {'status': 'report_submission_unconfirmed', 'writes_performed': False}}
                self.save(identity, state)
                reply = await _bounded_json(client, BASE + 'Submit', headers=headers, json=report_request(account))
                job = reply.get('ReportRequestId')
                if not isinstance(job, str) or not 1 <= len(job) <= 40:
                    raise ValueError('MICROSOFT_REPORT_ID_MISSING')
                state.update(phase='poll', job=job, next_check=(now + timedelta(seconds=60)).isoformat(),
                             public={'status': 'report_pending', 'writes_performed': False})
                self.save(identity, state)
                return state['public']
            reply = await _bounded_json(client, BASE + 'Poll', headers=headers, json={'ReportRequestId': state['job']})
            status = reply['ReportRequestStatus']
            if status['Status'] == 'Pending':
                state.update(next_check=(now + timedelta(seconds=60)).isoformat())
                self.save(identity, state)
                return state['public']
            if status['Status'] != 'Success':
                raise ValueError('MICROSOFT_REPORT_FAILED')
            url = status.get('ReportDownloadUrl')
            rows = []
            if url:
                parsed = urlsplit(url)
                host = parsed.hostname or ''
                # Authenticated provider response is the only URL source. Never attach
                # Microsoft API credentials to download hosts, follow redirects or store SAS URLs.
                if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in {None, 443}
                    or not any(host.endswith('.' + suffix) for suffix in ('bingads.microsoft.com', 'ads.microsoft.com', 'blob.core.windows.net'))):
                    raise ValueError('MICROSOFT_REPORT_DOWNLOAD_HOST_REQUIRES_REVIEW')
                data = bytearray()
                async with client.stream('GET', url, headers={}, follow_redirects=False) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > MAX_DOWNLOAD:
                            raise ValueError('MICROSOFT_DOWNLOAD_TOO_LARGE')
                rows = parse_report(bytes(data), account)
            public = {'status': 'observed', 'account_id': account, 'campaigns': rows, 'observed_at': now.isoformat(),
                'report_window': 'LAST_SEVEN_DAYS_PROVIDER_DEFAULT_TIMEZONE', 'currency': 'EUR' if rows else None,
                'performance_metrics_available': True, 'read_only': True, 'writes_performed': False,
                'conversions_are_not_verified_purchases': True, 'common_window_verified': False,
                'net_profit_verified': False, 'additional_spend_authorized': False}
            state.update(phase='complete', public=public, next_check=(now + timedelta(minutes=30)).isoformat())
            self.save(identity, state)
            return public
        except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError, zipfile.BadZipFile, httpx.HTTPError) as exc:
            public = {'status': 'unavailable', 'error_type': type(exc).__name__, 'writes_performed': False,
                      'performance_metrics_available': False}
            state = state or {'created_at': now.isoformat()}
            state.update(phase='failed', public=public, next_check=(now + timedelta(minutes=15)).isoformat())
            self.save(identity, state)
            return public
        finally:
            if own:
                await client.aclose()
