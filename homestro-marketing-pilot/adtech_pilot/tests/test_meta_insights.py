from datetime import date

import httpx
import pytest

from adtech_pilot.media_buyer import Platform
from adtech_pilot.meta_insights import MetaInsightsClient


@pytest.mark.asyncio
async def test_reads_campaign_metrics_without_marking_attribution_verified():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "campaign_id": "12345",
                        "campaign_name": "Homestro DE",
                        "spend": "12.34",
                        "impressions": "1000",
                        "clicks": "25",
                        "actions": [
                            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "2"}
                        ],
                        "action_values": [
                            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "79.80"}
                        ],
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await MetaInsightsClient(
            "never-print-this", "act_12345", client=client
        ).campaign_metrics(days=7, until=date(2026, 10, 23))

    metric = result[0]
    assert metric.platform == Platform.META
    assert metric.campaign_id == "12345"
    assert metric.spend_eur == 12.34
    assert metric.revenue_eur == 79.8
    assert metric.conversions == 2
    assert metric.daily_budget_eur == 0
    assert metric.contribution_margin_eur is None
    assert metric.attribution_verified is False
    assert requests[0].method == "GET"
    assert requests[0].url.path.endswith("/act_12345/insights")
    assert requests[0].url.params.get("level") == "campaign"
    assert "2026-10-17" in requests[0].url.params.get("time_range")
    assert "2026-10-23" in requests[0].url.params.get("time_range")


@pytest.mark.asyncio
async def test_prefers_pixel_purchase_action_without_double_counting_omni_purchase():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "campaign_id": "12345",
                            "actions": [
                                {"action_type": "omni_purchase", "value": "9"},
                                {
                                    "action_type": "offsite_conversion.fb_pixel_purchase",
                                    "value": "2",
                                },
                            ],
                            "action_values": [
                                {"action_type": "omni_purchase", "value": "500"},
                                {
                                    "action_type": "offsite_conversion.fb_pixel_purchase",
                                    "value": "80",
                                },
                            ],
                        }
                    ]
                },
            )
        )
    ) as client:
        metric = (
            await MetaInsightsClient("token", "act_12345", client=client).campaign_metrics()
        )[0]

    assert metric.conversions == 2
    assert metric.revenue_eur == 80


def test_rejects_invalid_account_version_and_window():
    with pytest.raises(ValueError):
        MetaInsightsClient("token", "12345")
    with pytest.raises(ValueError):
        MetaInsightsClient("token", "act_12345", api_version="latest")
