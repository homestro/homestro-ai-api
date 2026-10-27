"""Owner's sales goals measured against signed orders, never inferred from clicks."""
from __future__ import annotations

from contextlib import closing
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from .order_economics import economics_summary

GOAL = {'version': 'homestro-owner-10-orders-10-eur-v1', 'orders_per_day': 10,
        'minimum_profit_per_order_eur': '10.00', 'implied_minimum_daily_profit_eur': '100.00',
        'timezone': 'Europe/Berlin', 'markets': ['DE', 'AT'], 'currency': 'EUR',
        'target_is_not_forecast': True, 'grants_spending_authority': False}


def sales_goal_progress(store, *, now=None):
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError('TIMEZONE_REQUIRED')
    zone = ZoneInfo(GOAL['timezone'])
    day = now.astimezone(zone).date()
    start = datetime.combine(day, time.min, zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time.min, zone).astimezone(UTC)
    cutoff = min(now.astimezone(UTC), end)
    with closing(store.connect()) as db:
        groups = db.execute('''SELECT DISTINCT campaign,channel FROM pilot_order_economics
            WHERE julianday(paid_at)>=julianday(?) AND julianday(paid_at)<julianday(?)
            ORDER BY channel,campaign LIMIT 501''', (start.isoformat(), cutoff.isoformat())).fetchall()
    if len(groups) > 500:
        return {'status': 'unavailable', 'goal': GOAL.copy(), 'reason': 'GOAL_CAMPAIGN_LIMIT',
                'spend_authorized': False, 'profit_goal_verified': False}
    summaries = [economics_summary(store, campaign, None, channel=channel,
        window_start=start.isoformat(), window_end=cutoff.isoformat()) for campaign, channel in groups]
    orders = sum(row['signed_url_tagged_paid_orders'] for row in summaries)
    cancelled = sum(row['refund_or_cancelled_orders'] for row in summaries)
    complete = bool(summaries) and all(row['costs_complete'] for row in summaries)
    # Ad spend has no verified daily common-window source here. Do not substitute
    # lifetime/week data or call gross revenue, margin or contribution net profit.
    before_ads = None
    if complete:
        zero_spend = [economics_summary(store, campaign, 0, channel=channel,
            window_start=start.isoformat(), window_end=cutoff.isoformat()) for campaign, channel in groups]
        before_ads = str(sum((Decimal(row['contribution_after_ads_decimal_eur']) for row in zero_spend), Decimal(0)))
    return {'status': 'observed', 'goal': GOAL.copy(), 'day': day.isoformat(),
            'window_start': start.isoformat(), 'window_end': end.isoformat(), 'checked_at': now.isoformat(),
            'signed_attributed_paid_orders': orders, 'refund_or_cancelled_orders': cancelled,
            'orders_remaining': max(0, GOAL['orders_per_day'] - orders), 'order_goal_reached': orders >= GOAL['orders_per_day'],
            'all_shop_orders': None, 'measurement_scope': 'signed_url_tagged_orders_only_not_all_shop_sales',
            'costs_complete': complete, 'contribution_before_ads_eur': before_ads,
            'actual_net_profit_eur': None, 'profit_goal_verified': False,
            'blockers': ([] if complete else ['ACTUAL_ORDER_COSTS_INCOMPLETE_OR_NO_ORDERS']) +
                ['VERIFIED_DAILY_AD_SPEND_REQUIRED', 'FULL_NET_PROFIT_ACCOUNTING_REQUIRED'],
            'spend_authorized': False, 'budget_increase_authorized': False,
            'goal_miss_action': 'REVIEW_FUNNEL_AND_EXISTING_ORGANIC_WORK', 'external_writes_performed': False}
