"""Read-only Meta Ads Insights ingestion for the Homestro AdTech Pilot."""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from .media_buyer import MetricSnapshot, Platform


class MetaInsightsClient:
    """Fetch one bounded campaign-level page of Meta-reported performance.

    This client is strictly read-only. Meta-reported purchase values are not
    treated as independently verified Shopify revenue or contribution margin.
    """

    ENDPOINT = "https://graph.facebook.com"
    ACCOUNT_PATTERN = re.compile(r"^act_\d{4,30}$")
    API_VERSION_PATTERN = re.compile(r"^v\d+\.\d+$")
    FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values"
    PURCHASE_ACTIONS = (
        "offsite_conversion.fb_pixel_purchase",
        "purchase",
        "omni_purchase",
        "onsite_conversion.purchase",
    )

    def __init__(
        self,
        access_token: str,
        account_id: str,
        *,
        api_version: str = "v26.0",
        client: httpx.AsyncClient | None = None,
    ):
        if not access_token:
            raise ValueError("Meta Insights access token is required")
        if not self.ACCOUNT_PATTERN.fullmatch(account_id):
            raise ValueError("Meta ad account id is invalid")
        if not self.API_VERSION_PATTERN.fullmatch(api_version):
            raise ValueError("Meta Graph API version is invalid")
        self.access_token = access_token
        self.account_id = account_id
        self.api_version = api_version
        self.client = client

    async def campaign_metrics(
        self, *, days: int = 7, until: date | None = None
    ) -> list[MetricSnapshot]:
        """Return up to 100 campaign metrics for a bounded recent date window."""
        if not 1 <= days <= 30:
            raise ValueError("days must be between 1 and 30")
        end = until or datetime.now(UTC).date()
        start = end - timedelta(days=days - 1)
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        try:
            response = await client.get(
                f"{self.ENDPOINT}/{self.api_version}/{self.account_id}/insights",
                headers={"Authorization": f"Bearer {self.access_token}"},
                params={
                    "level": "campaign",
                    "time_range": json.dumps(
                        {"since": start.isoformat(), "until": end.isoformat()},
                        separators=(",", ":"),
                    ),
                    "fields": self.FIELDS,
                    "limit": 100,
                },
            )
            response.raise_for_status()
            payload = response.json()
        finally:
            if own_client:
                await client.aclose()

        rows = payload.get("data", []) if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            raise ValueError("Meta Insights returned an invalid data page")
        snapshots: list[MetricSnapshot] = []
        for row in rows[:100]:
            if not isinstance(row, dict) or not row.get("campaign_id"):
                continue
            snapshots.append(
                MetricSnapshot(
                    platform=Platform.META,
                    campaign_id=str(row["campaign_id"])[:80],
                    campaign_name=str(row.get("campaign_name", ""))[:200],
                    # Insights does not include campaign budgets. Keep this zero
                    # until a separate read-only campaign-state lookup is added.
                    daily_budget_eur=0.0,
                    spend_eur=_number(row.get("spend")),
                    revenue_eur=_purchase_value(row.get("action_values")),
                    conversions=_purchase_count(row.get("actions")),
                    clicks=_integer(row.get("clicks")),
                    impressions=_integer(row.get("impressions")),
                    contribution_margin_eur=None,
                    attribution_verified=False,
                )
            )
        return snapshots


def _number(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if result >= 0 and result < float("inf") else 0.0


def _integer(value: Any) -> int:
    return max(0, int(round(_number(value))))


def _action_value(actions: Any, accepted_types: tuple[str, ...]) -> float:
    if not isinstance(actions, list):
        return 0.0
    for action_type in accepted_types:
        matching = [
            _number(item.get("value"))
            for item in actions
            if isinstance(item, dict) and item.get("action_type") == action_type
        ]
        if matching:
            return sum(matching)
    return 0.0


def _purchase_value(actions: Any) -> float:
    return _action_value(actions, MetaInsightsClient.PURCHASE_ACTIONS)


def _purchase_count(actions: Any) -> int:
    return _integer(_action_value(actions, MetaInsightsClient.PURCHASE_ACTIONS))
