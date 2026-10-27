"""Durable Berlin-day evidence snapshots. Unknown costs and revenue remain unknown."""
from __future__ import annotations

import json
import re
from contextlib import closing
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

SECTIONS = ('organic_operations', 'organic_catalog_brain', 'product_selection',
            'sales_goal_progress', 'cross_channel_accounting', 'cross_channel_budget_proposal',
            'purchase_watchdog', 'publisher_media_handoff', 'search_write_recovery')


class DailyMarketingReports:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_daily_marketing('
                       'day TEXT PRIMARY KEY, generated_at TEXT NOT NULL, payload TEXT NOT NULL)')

    def refresh(self, evidence, *, now=None):
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        day = now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
        sections = {}
        for name in SECTIONS:
            row = evidence.get(name)
            if not isinstance(row, dict):
                sections[name] = {'status': 'unknown', 'observed_at': None, 'payload': None}
                continue
            try:
                observed = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
                age = (now - observed).total_seconds()
                fresh = observed.tzinfo is not None and -60 <= age <= 900
            except (ValueError, KeyError, TypeError, AttributeError):
                fresh = False
            sections[name] = {'status': 'fresh' if fresh else 'historical_or_invalid_time',
                              'observed_at': row.get('created_at'), 'payload': row.get('payload')}
        report = {'version': 1, 'brand': 'Homestro', 'markets': ['DE', 'AT'], 'day': day,
                  'generated_at': now.isoformat(), 'sections': sections,
                  'total_net_profit_eur': None, 'net_profit_verified': False,
                  'economics_scope': 'see per-channel signed-order accounting and explicit missing actual costs',
                  'ad_spend_authorized_eur': '0', 'budget_increase_authorized': False,
                  'new_publication_confirmed': False,
                  'evidence_level': 'timestamped_persisted_sources_not_causal_marketing_results'}
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_daily_marketing(day,generated_at,payload) VALUES(?,?,?) '
                       'ON CONFLICT(day) DO UPDATE SET generated_at=excluded.generated_at,payload=excluded.payload',
                       (day, now.isoformat(), json.dumps(report, separators=(',', ':'))))
        return report

    def get(self, day=None):
        day = day or datetime.now(ZoneInfo('Europe/Berlin')).date().isoformat()
        if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise ValueError('INVALID_REPORT_DAY')
        date.fromisoformat(day)
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT payload FROM pilot_daily_marketing WHERE day=?', (day,)).fetchone()
        return json.loads(row[0]) if row else {'status': 'not_observed', 'day': day}
