import asyncio
import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from agents import product_hunter  # noqa: E402


class _Store:
    def __init__(self, latest=None):
        self.latest = latest
        self.records = []

    async def latest_record(self, kind):
        return self.latest

    async def record(self, kind, payload):
        self.records.append((kind, payload))
        return "audit-id"


class ProductHunterTrendTests(unittest.TestCase):
    def setUp(self):
        product_hunter._TREND_MEMORY_CACHE = None

    def test_missing_token_skips_meta_without_constructing_clients(self):
        with patch.object(product_hunter, "MetaAdLibraryClient") as client:
            result = asyncio.run(product_hunter._scan_meta_trends([], {}))
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "META_AD_LIBRARY_ACCESS_TOKEN_MISSING")
        client.assert_not_called()

    def test_active_german_ads_are_scored_matched_and_unmatched_are_queued(self):
        now = datetime.now(UTC)
        ads = [
            SimpleNamespace(
                library_id="matched-ad",
                page_name="Kitchen Store",
                started_at=(now - timedelta(days=20)).isoformat(),
                ad_copy=["Bambus Schneidebrett clever organisieren"],
                snapshot_url="https://www.facebook.com/ads/library/?id=matched-ad",
            ),
            SimpleNamespace(
                library_id="unmatched-ad",
                page_name="Home Store",
                started_at=(now - timedelta(days=10)).isoformat(),
                ad_copy=["Praktischer Wäschekorb für jeden Haushalt"],
                snapshot_url="https://www.facebook.com/ads/library/?id=unmatched-ad",
            ),
        ]

        class _Client:
            def __init__(self, token, *, api_version):
                self.token = token
                self.api_version = api_version

            async def search(self, terms, *, country, limit, active_only):
                self.args = (terms, country, limit, active_only)
                return ads

        store = _Store()
        products = [{
            "id": "shopify-1",
            "title": "Bambus Schneidebrett mit Halter",
            "product_type": "Küche",
        }]
        with patch.object(product_hunter, "MetaAdLibraryClient", _Client), patch.object(
            product_hunter, "PlanAuditStore", return_value=store
        ):
            result = asyncio.run(product_hunter._scan_meta_trends(
                products,
                {"META_AD_LIBRARY_ACCESS_TOKEN": "test-token", "META_AD_LIBRARY_SCAN_INTERVAL_HOURS": "6"},
            ))

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["country"], "DE")
        self.assertEqual(result["matched_products"][0]["product_id"], "shopify-1")
        self.assertEqual(result["matched_products"][0]["longevity_score"], 100)
        self.assertEqual(result["queued_suggestions"][0]["suggestion_id"], "unmatched-ad")
        self.assertEqual(result["queued_suggestions"][0]["status"], "awaiting_product_research")
        self.assertEqual(result["queue_status"], "persisted_for_review")
        self.assertEqual(store.records[0][0], "product_trend_queue")

    def test_rate_limit_returns_partial_and_does_not_raise(self):
        request = httpx.Request("GET", "https://graph.facebook.com/v26.0/ads_archive")
        response = httpx.Response(429, request=request)

        class _Client:
            def __init__(self, token, *, api_version):
                pass

            async def search(self, terms, *, country, limit, active_only):
                raise httpx.HTTPStatusError("rate limited", request=request, response=response)

        store = _Store()
        with patch.object(product_hunter, "MetaAdLibraryClient", _Client), patch.object(
            product_hunter, "PlanAuditStore", return_value=store
        ):
            result = asyncio.run(product_hunter._scan_meta_trends(
                [], {"META_ACCESS_TOKEN": "test-token"}
            ))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], ["META_AD_LIBRARY_HTTP_429"])
        self.assertEqual(result["active_ads_checked"], 0)
        self.assertEqual(result["queued_suggestions"], [])

    def test_empty_response_completes_with_empty_queue(self):
        class _Client:
            def __init__(self, token, *, api_version):
                pass

            async def search(self, terms, *, country, limit, active_only):
                self.asserted = (country, active_only)
                return []

        store = _Store()
        with patch.object(product_hunter, "MetaAdLibraryClient", _Client), patch.object(
            product_hunter, "PlanAuditStore", return_value=store
        ):
            result = asyncio.run(product_hunter._scan_meta_trends(
                [], {"META_AD_LIBRARY_ACCESS_TOKEN": "test-token"}
            ))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["active_ads_checked"], 0)
        self.assertEqual(result["suggestion_count"], 0)

    def test_recent_persisted_scan_is_reused_without_api_call(self):
        cached = {
            "created_at": datetime.now(UTC).isoformat(),
            "payload": {"status": "completed", "active_ads_checked": 1, "matched_products": []},
        }
        store = _Store(latest=cached)
        with patch.object(product_hunter, "MetaAdLibraryClient") as client, patch.object(
            product_hunter, "PlanAuditStore", return_value=store
        ):
            result = asyncio.run(product_hunter._scan_meta_trends(
                [], {"META_AD_LIBRARY_ACCESS_TOKEN": "test-token"}
            ))
        self.assertTrue(result["cache_hit"])
        self.assertEqual(result["active_ads_checked"], 1)
        client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
