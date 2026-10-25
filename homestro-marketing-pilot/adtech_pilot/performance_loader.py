"""Read real Meta delivery metrics without treating attributed revenue as profit."""
from __future__ import annotations

import os
import re
from decimal import Decimal

import httpx


async def load_meta_performance(audit, *, env=None, client=None):
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
                "date_preset": "maximum", "level": "campaign", "limit": "100"})
        response.raise_for_status()
        body = response.json()
        if not isinstance(body.get("data"), list) or (body.get("paging") or {}).get("next"):
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
                for key in ("purchase", "offsite_conversion.fb_pixel_purchase"):
                    if key in indexed:
                        return number(indexed[key])
                return 0.0
            metrics.append({"campaign_id": campaign, "spend_eur": number(row["spend"]),
                "impressions": number(row["impressions"]), "clicks": number(row["clicks"]),
                "reported_purchases": purchase(row.get("actions", [])),
                "reported_purchase_value_eur": purchase(row.get("action_values", [])),
                "date_start": row["date_start"], "date_stop": row["date_stop"],
                "attribution_verified": False, "contribution_margin_eur": None})
        result = {"status": "collected", "metrics": metrics, "attribution_verified": False,
                  "scaling_blocker": "ORDER_ATTRIBUTION_AND_LANDED_COST_REQUIRED"}
        await audit.record("meta_performance_snapshot", result)
        return result
    except Exception as exc:
        return {"status": "unavailable", "reason": "META_METRICS_READ_FAILED", "error_type": type(exc).__name__}
    finally:
        if own:
            await client.aclose()
