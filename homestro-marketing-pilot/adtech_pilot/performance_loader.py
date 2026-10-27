"""Read real Meta delivery metrics without treating attributed revenue as profit."""
from __future__ import annotations

import os
import re
from decimal import Decimal

import httpx


async def load_meta_performance(audit, *, env=None, client=None, window="maximum"):
    if window not in {"maximum", "yesterday"}:
        raise ValueError("unsupported metric window")
    env = os.environ if env is None else env
    claim = await audit.get_meta_micro_campaign_claim()
    campaign = str((claim or {}).get("campaign_id") or "")
    if not campaign:
        return {"status": "no_managed_campaign", "metrics": [], "attribution_verified": False}
    version, token = env.get("META_API_VERSION", "v26.0"), env.get("META_ACCESS_TOKEN", "")
    if not token or not re.fullmatch(r"\d{4,30}", campaign) or not re.fullmatch(r"v\d+\.\d+", version):
        return {"status": "blocked", "reason": "META_METRICS_CONFIGURATION_INVALID"}
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
    try:
        response = await client.get(f"https://graph.facebook.com/{version}/{campaign}/insights",
            headers={"Authorization": f"Bearer {token}"}, params={
                "fields": "campaign_id,account_currency,spend,impressions,clicks,actions,action_values,date_start,date_stop",
                "date_preset": window, "level": "campaign", "limit": "100"})
        response.raise_for_status()
        body = response.json()
        if (not isinstance(body.get("data"), list) or len(body["data"]) > 1
                or (body.get("paging") or {}).get("next")):
            return {"status": "blocked", "reason": "META_METRICS_INCOMPLETE"}
        metrics = []
        for row in body["data"]:
            if str(row.get("campaign_id")) != campaign or row.get("account_currency") != "EUR":
                return {"status": "blocked", "reason": "META_METRICS_SCOPE_OR_CURRENCY_MISMATCH"}
            def number(raw):
                value = Decimal(str(raw))
                if not value.is_finite() or value < 0:
                    raise ValueError("invalid metric")
                return float(value)
            def purchase(values):
                # The umbrella purchase action overlaps with pixel_purchase.
                # Choose one canonical key; never add overlapping counters.
                indexed = {value["action_type"]: value["value"] for value in values}
                if len(indexed) != len(values):
                    raise ValueError("duplicate action counter")
                for key in ("purchase", "offsite_conversion.fb_pixel_purchase"):
                    if key in indexed:
                        return number(indexed[key])
                return 0.0
            metrics.append({"campaign_id": campaign, "spend_eur": number(row["spend"]),
                "impressions": number(row["impressions"]), "clicks": number(row["clicks"]),
                "reported_purchases": purchase(row.get("actions", [])),
                "reported_purchase_value_eur": purchase(row.get("action_values", [])),
                "date_start": row["date_start"], "date_stop": row["date_stop"],
                "reported_roas": (purchase(row.get("action_values", [])) / number(row["spend"])
                                  if number(row["spend"]) > 0 else None),
                "attribution_verified": False, "contribution_margin_eur": None})
        result = {"status": "collected", "window": window, "metrics": metrics, "attribution_verified": False,
                  "scaling_blocker": "ORDER_ATTRIBUTION_AND_LANDED_COST_REQUIRED"}
        await audit.record("meta_performance_snapshot", result)
        return result
    except Exception as exc:
        return {"status": "unavailable", "reason": "META_METRICS_READ_FAILED", "error_type": type(exc).__name__}
    finally:
        if own:
            await client.aclose()


def performance_decision(performance, *, current_daily_budget_eur=5, daily_cap_eur=5):
    """Reported Meta outcomes are not verified profit; never authorizes budget writes."""
    base = {"action": "hold", "budget_write_authorized": False,
            "attribution_verified": False, "basis": "meta_reported_campaign_lifetime"}
    if performance.get("status") != "collected":
        return {**base, "action": "pause", "reason": "PERFORMANCE_UNAVAILABLE"}
    rows = performance.get("metrics", [])
    if not rows:
        return {**base, "reason": "NO_DELIVERY_DATA"}
    if len(rows) != 1:
        return {**base, "action": "pause", "reason": "PERFORMANCE_SCOPE_AMBIGUOUS"}
    if performance.get("window", "maximum") != "maximum":
        return {**base, "reason": "LIFETIME_WINDOW_REQUIRED"}
    try:
        row = rows[0]
        spend, purchases, value, current, cap = (
            Decimal(str(raw)) for raw in (row["spend_eur"], row["reported_purchases"],
            row.get("reported_purchase_value_eur", 0), current_daily_budget_eur, daily_cap_eur))
        if any(not number.is_finite() or number < 0 for number in (spend, purchases, value, current, cap)):
            raise ValueError("invalid metric")
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return {**base, "action": "pause", "reason": "PERFORMANCE_INVALID"}
    roas = value / spend if spend > 0 else None
    base.update({"spend_eur": float(spend), "reported_purchases": float(purchases),
                 "reported_roas": float(roas) if roas is not None else None,
                 "current_daily_budget_eur": float(current), "daily_cap_eur": float(cap)})
    if spend >= Decimal("35"):
        return {**base, "action": "pause", "reason": "TEST_TOTAL_BUDGET_REACHED"}
    if spend > Decimal("15") and purchases == 0:
        return {**base, "action": "pause", "reason": "SPEND_OVER_15_WITH_NO_REPORTED_PURCHASE"}
    if current > min(cap, Decimal("5")):
        return {**base, "action": "pause", "reason": "DAILY_BUDGET_EXCEEDS_AUTHORIZATION"}
    if roas is not None and roas >= 3 and purchases >= 3:
        return {**base, "reason": "SCALE_BLOCKED_BUDGET_CAP_AND_UNVERIFIED_PROFIT",
                "uncapped_proposal_eur": float((current * Decimal("1.20")).quantize(Decimal("0.01"))),
                "allowed_daily_budget_eur": float(min(current, cap, Decimal("5")))}
    if roas is not None and roas < Decimal("1.5") and spend > 5:
        return {**base, "reason": "WEAK_ROAS_AT_MINIMUM_TEST_BUDGET"}
    return {**base, "reason": "CONTINUE_BOUNDED_TEST"}
