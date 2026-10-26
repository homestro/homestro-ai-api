"""Normalize observed spend and signed order costs without inventing common windows.

The deterministic optimizer sees actual evidence, including explicit blockers.
Provider conversions/revenue never substitute for signed paid orders or costs.
"""
from __future__ import annotations

import re
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .channel_control import CHANNELS, amount
from .order_economics import economics_summary, instant


def common_window(now):
    end = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return (end - timedelta(days=7)).isoformat(), end.isoformat()


def reported_spend(channel, source):
    if channel == 'meta':
        if source.get('status') != 'collected' or source.get('currency', 'EUR') != 'EUR':
            return None
        rows = source.get('metrics')
        field, divisor = 'spend_eur', Decimal(1)
    elif channel == 'google':
        if source.get('status') != 'observed' or source.get('currency') != 'EUR':
            return None
        rows = source.get('campaigns')
        field, divisor = 'cost_micros', Decimal(1000000)
    else:
        if source.get('status') != 'observed' or source.get('currency') != 'EUR':
            return None
        rows = source.get('campaigns')
        field, divisor = 'spend_eur', Decimal(1)
    if not isinstance(rows, list) or len(rows) > 500:
        return None
    if any(not isinstance(row, dict) or field not in row for row in rows):
        return None
    ids = [str(row.get('campaign_id') if channel == 'meta' else row.get('id')) for row in rows]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r'[1-9]\d{0,29}', key) for key in ids):
        return None
    return sum((amount(row[field]) / divisor for row in rows), Decimal(0))


def accounting_observations(store, providers, *, now=None, authorized_channels=()):
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError('TIMEZONE_REQUIRED')
    if not isinstance(providers, dict):
        providers = {}
    start, end = common_window(now)
    observations = {}
    for channel in CHANNELS:
        raw_source = providers.get(channel)
        source = raw_source if isinstance(raw_source, dict) else {}
        blockers = []
        if raw_source is not None and not isinstance(raw_source, dict):
            blockers.append('PROVIDER_EVIDENCE_INVALID')
        try:
            spend = reported_spend(channel, source)
        except (ValueError, TypeError, ArithmeticError, KeyError):
            spend = None
        if spend is None:
            blockers.append('PROVIDER_SPEND_UNAVAILABLE_OR_INVALID')
        try:
            age = (now - instant(source.get('observed_at'))).total_seconds()
            fresh = -60 <= age <= 900
        except (ValueError, TypeError, AttributeError):
            fresh = False
        if not fresh:
            blockers.append('PROVIDER_EVIDENCE_STALE_OR_UNDATED')
        # Existing lifetime/default-account-timezone reports intentionally fail this
        # check. Only an explicit, identical half-open interval may be compared.
        try:
            aligned = (instant(source.get('window_start')) == instant(start)
                       and instant(source.get('window_end')) == instant(end)
                       and source.get('window_timezone') == 'UTC'
                       and source.get('campaign_scope_verified') is True
                       and source.get('report_complete') is True
                       and isinstance(source.get('owned_campaign_ids'), list)
                       and bool(source['owned_campaign_ids'])
                       and all(isinstance(key, str) and re.fullmatch(r'[1-9]\d{0,29}', key) for key in source['owned_campaign_ids']))
        except (ValueError, TypeError, AttributeError):
            aligned = False
        if not aligned:
            blockers.append('EXACT_COMMON_WINDOW_AND_CAMPAIGN_SCOPE_REQUIRED')
        with closing(store.connect()) as db:
            campaigns = [row[0] for row in db.execute(
                'SELECT DISTINCT campaign FROM pilot_order_economics WHERE channel=? '
                'AND julianday(paid_at)>=julianday(?) AND julianday(paid_at)<julianday(?) LIMIT 501',
                (channel, start, end)).fetchall()]
        if len(campaigns) > 500:
            raise ValueError('ACCOUNTING_CAMPAIGN_LIMIT')
        source_rows = source.get('metrics') if channel == 'meta' else source.get('campaigns')
        raw_owned = source.get('owned_campaign_ids')
        owned_valid = (isinstance(raw_owned, list) and bool(raw_owned) and len(raw_owned) <= 500
                       and all(isinstance(key, str) and re.fullmatch(r'[1-9]\d{0,29}', key) for key in raw_owned)
                       and len(set(raw_owned)) == len(raw_owned))
        owned = set(raw_owned) if owned_valid else set()
        if not owned_valid:
            aligned = False
            blockers.append('OWNED_CAMPAIGN_SCOPE_INVALID')
        source_ids = {str(row.get('campaign_id') if channel == 'meta' else row.get('id'))
                      for row in source_rows if isinstance(row, dict)} if isinstance(source_rows, list) else set()
        # Every owned campaign needs an explicit spend observation, including zero.
        # Omitted rows cannot silently become zero and inflate contribution.
        if owned_valid and source_ids != owned:
            aligned = False
            blockers.append('OWNED_CAMPAIGN_SPEND_COVERAGE_INCOMPLETE')
        if not set(campaigns).issubset(owned) or not source_ids.issubset(owned):
            aligned = False
            blockers.append('SIGNED_ORDER_OR_PROVIDER_CAMPAIGN_SCOPE_UNVERIFIED')
        summaries = [economics_summary(store, campaign, 0, channel=channel, window_start=start, window_end=end)
                     for campaign in campaigns]
        orders = sum(row['signed_url_tagged_paid_orders'] for row in summaries)
        complete = bool(summaries) and all(row['costs_complete'] for row in summaries)
        if not complete:
            blockers.append('SIGNED_ORDER_COSTS_INCOMPLETE_OR_NO_ORDERS')
        contribution = None
        if complete and aligned and fresh and spend is not None:
            contribution = sum((Decimal(row['contribution_after_ads_decimal_eur']) for row in summaries), Decimal(0)) - spend
        observations[channel] = {'currency': 'EUR', 'fresh': fresh, 'common_window_verified': aligned,
            'costs_complete': complete, 'signed_orders_verified': orders > 0,
            'channel_spend_authorized': channel in authorized_channels,
            'orders': orders, 'spend_eur': str(spend) if spend is not None else None,
            'contribution_after_ads_eur': str(contribution) if contribution is not None else None,
            'requested_window_start': start, 'requested_window_end': end,
            'provider_window_label': source.get('window') or source.get('report_window'),
            'blockers': blockers, 'evidence_level': 'signed_url_orders_and_recorded_costs_not_causal_lift',
            'net_profit_verified': False, 'writes_performed': False}
    return observations
