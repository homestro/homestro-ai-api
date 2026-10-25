"""Evidence-based operating report; no invented provider readiness or profit."""
from __future__ import annotations

from datetime import UTC, datetime

KINDS = ('autonomous_brain', 'meta_performance_snapshot', 'meta_performance_decision',
         'daemon_heartbeat', 'purchase_watchdog', 'pilot_control_cycle', 'product_selection', 'storefront_diagnostics', 'content_drafts', 'seo_publication', 'marketing_director', 'existing_media_import', 'organic_publisher_evidence', 'search_channel_evidence', 'cognitive_strategy', 'publisher_media_handoff', 'search_campaign_drafts', 'microsoft_performance_report', 'google_paused_creation', 'microsoft_paused_creation', 'cross_channel_budget_proposal')


def operating_report(latest, claim, *, daily_cap_eur, now=None):
    now = now or datetime.now(UTC)
    def payload(kind):
        return (latest.get(kind) or {}).get('payload', {})
    brain = payload('autonomous_brain')
    memory = payload('brain_memory')
    performance = payload('meta_performance_snapshot')
    watchdog = payload('purchase_watchdog')
    heartbeat = payload('daemon_heartbeat')
    jobs = heartbeat.get('jobs', {})
    costs = (jobs.get('feed_diagnostics') or {}).get('unit_costs', {})
    economics = (jobs.get('media_buying_plan') or {}).get('order_economics', {})
    trends = jobs.get('competitor_scan', {})
    metrics = performance.get('metrics', [])
    stopped = bool(claim and str(claim.get('status', '')).startswith('STOPPED_'))
    if stopped:
        action = 'KEEP_MANAGED_TEST_PAUSED'
    elif brain.get('reason') in {'CREATIVE_CREATE_UNCERTAIN_NO_RETRY', 'CREATIVE_RECONCILIATION_AMBIGUOUS'}:
        action = 'RECONCILE_EXISTING_CREATIVE_INTENT'
    elif brain.get('reason') == 'AD_REVIEW_OR_DELIVERY_NOT_ACTIVE':
        action = 'WAIT_FOR_META_AD_REVIEW_OR_DELIVERY'
    elif not metrics:
        action = 'WAIT_FOR_REPORTED_DELIVERY_DATA'
    else:
        action = 'EVALUATE_BOUNDED_EXPERIMENT'
    timestamps = {}
    stale = []
    for kind, record in latest.items():
        if kind == 'brain_memory':
            continue
        at = record.get('created_at')
        timestamps[kind] = at
        try:
            parsed = datetime.fromisoformat(str(at).replace('Z', '+00:00'))
            age = (now - parsed).total_seconds()
            threshold = 900 if kind != 'daemon_heartbeat' else 7200
            if age > threshold or age < -60:
                stale.append(kind)
        except (TypeError, ValueError):
            stale.append(kind)
    if 'autonomous_brain' in stale and not stopped:
        action = 'BRAIN_EVIDENCE_STALE_CHECK_REQUIRED'
    return {
        'checked_at': now.isoformat(), 'campaign': claim, 'next_action': action,
        'daily_budget_limit_eur': daily_cap_eur, 'budget_increase_authorized': False,
        'control_cycle': payload('pilot_control_cycle'), 'brain': brain, 'persisted_memory': memory, 'campaign_control': watchdog, 'reported_metrics': metrics,
        'performance_decision': payload('meta_performance_decision'),
        'product_selection': payload('product_selection'), 'unit_cost_source': costs, 'order_economics': economics,
        'storefront_diagnostics': payload('storefront_diagnostics'),
        'content_drafts': payload('content_drafts'),
        'seo_publication': payload('seo_publication'),
        'publisher_media_handoff': payload('publisher_media_handoff'), 'search_campaign_drafts': payload('search_campaign_drafts'),
        'cognitive_strategy': payload('cognitive_strategy'),
        'search_channel_evidence': payload('search_channel_evidence'),
        'microsoft_performance_report': payload('microsoft_performance_report'),
        'google_paused_creation': payload('google_paused_creation'),
        'microsoft_paused_creation': payload('microsoft_paused_creation'),
        'cross_channel_budget_proposal': payload('cross_channel_budget_proposal'),
        'organic_publisher_evidence': payload('organic_publisher_evidence'),
        'marketing_director': payload('marketing_director'), 'existing_media_import': payload('existing_media_import'),
        'external_trend_sources': trends, 'source_timestamps': timestamps, 'stale_sources': stale,
        'full_autonomous_profit_optimization_verified': False,
        'remaining_dependencies': [
            name for name, missing in (
                ('META_DELIVERY_EVIDENCE', not metrics),
                ('SIGNED_TRACKING_ATTACHMENT', not (memory.get('tracking_installed') or brain.get('tracking_installed')
                     or brain.get('status') == 'rotation_confirmed')
                 or brain.get('reason') in {'EXTERNAL_CREATIVE_CHANGE', 'AD_ID_CHANGED_EXTERNALLY'}),
                ('ACTUAL_FULFILLMENT_PAYMENT_RETURN_COSTS', not economics.get('costs_complete')),
                ('AUTHORIZED_EXTERNAL_TREND_SOURCES', trends.get('meta') == 'AD_LIBRARY_OPERATION_REJECTED'
                 or trends.get('status') != 'completed'),
            ) if missing],
    }
