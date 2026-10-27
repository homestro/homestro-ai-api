"""One evidence-driven dispatch policy for the existing Pilot adapters."""
from __future__ import annotations

import math


def control_plan(*, product_count, feed_age_seconds, metrics_age_seconds,
                 performance_status, campaign_status, live_enabled, daily_cap_eur):
    plan = {'next_action': 'RUN_CREATIVE_CYCLE', 'creative_cycle_allowed': True,
            'product_count': product_count, 'feed_age_seconds': feed_age_seconds,
            'metrics_age_seconds': metrics_age_seconds, 'decision_basis': 'observed_provider_evidence',
            'budget_increase_authorized': False, 'paid_generation_authorized': False,
            'stages': ['shopify_feed', 'market_signals', 'performance', 'german_copy',
                       'existing_ad_publication', 'signed_order_economics'],
            'reason': 'CURRENT_FEED_AND_METRICS_AVAILABLE'}
    def hold(action, reason):
        return {**plan, 'next_action': action, 'reason': reason, 'creative_cycle_allowed': False}
    if str(campaign_status or '').startswith('STOPPED_'):
        return hold('KEEP_TEST_PAUSED', 'DURABLE_TEST_STOP')
    if not live_enabled:
        return hold('READ_ONLY_DIAGNOSTICS', 'LIVE_TEST_NOT_ENABLED')
    if not math.isfinite(daily_cap_eur) or not 0 < daily_cap_eur <= 5:
        return hold('KEEP_TEST_PAUSED', 'BUDGET_OUTSIDE_AUTHORIZATION')
    if product_count < 1 or feed_age_seconds is None:
        return hold('REFRESH_SHOPIFY_FEED', 'NO_VERIFIED_PRODUCT_SNAPSHOT')
    if not math.isfinite(feed_age_seconds) or not 0 <= feed_age_seconds <= 21600:
        return hold('REFRESH_SHOPIFY_FEED', 'PRODUCT_SNAPSHOT_STALE')
    if metrics_age_seconds is None or not math.isfinite(metrics_age_seconds) or not 0 <= metrics_age_seconds <= 900:
        return hold('REFRESH_META_METRICS', 'METRICS_SNAPSHOT_STALE')
    if performance_status not in {'collected', 'no_managed_campaign'}:
        return hold('REFRESH_META_METRICS', 'METRICS_PROVIDER_NOT_READABLE')
    return plan
