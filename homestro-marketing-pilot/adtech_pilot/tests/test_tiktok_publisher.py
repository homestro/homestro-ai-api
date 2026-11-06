import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from adtech_pilot.organic_bridge import ORIGIN  # noqa: E402

from agents import orchestrator  # noqa: E402
from agents.tiktok_publisher import prepare_existing_drafts, run_once  # noqa: E402

PRODUCT_ID = "gid://shopify/Product/123"
VIDEO_URL = f"{ORIGIN}/marketing-assets/{'a' * 64}.mp4"


def candidate():
    return {"id": PRODUCT_ID, "url": "https://homestro.de/products/test", "title": "Testprodukt"}


def post(**overrides):
    row = {
        "id": "post-1",
        "product_id": PRODUCT_ID,
        "channel": "tiktok",
        "status": "draft_queued",
        "payload": {
            "importedMedia": True,
            "format": "reels",
            "videoURL": VIDEO_URL,
            "caption": "Entdecke dieses geprüfte Produkt.",
            "requiresVisualReview": True,
        },
    }
    row.update(overrides)
    return row


class FakeResponse:
    def __init__(self, rows):
        self._rows = rows
        self.content = b"[]"

    def raise_for_status(self):
        return None

    def json(self):
        return self._rows


class FakeClient:
    def __init__(self, rows_by_status):
        self.rows_by_status = rows_by_status
        self.calls = []

    async def get(self, url, *, params, headers):
        self.calls.append((url, params, headers))
        return FakeResponse(self.rows_by_status.get(params["status"], []))


class TikTokPublisherTests(unittest.TestCase):
    def test_prepares_only_matching_existing_vertical_video_without_posting(self):
        result = prepare_existing_drafts([candidate()], [post()])
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["prepared_count"], 1)
        draft = result["drafts"][0]
        self.assertEqual(draft["format"], "vertical_9_16_mp4")
        self.assertEqual(draft["status"], "needs_tiktok_review")
        self.assertEqual(draft["content_posting_api"]["source"], "PULL_FROM_URL")
        self.assertTrue(draft["content_posting_api"]["requires_verified_url_prefix"])
        self.assertFalse(result["upload_performed"])
        self.assertFalse(result["publication_performed"])
        self.assertEqual(draft["ads_material"]["daily_budget_eur"], 0)
        self.assertFalse(draft["ads_material"]["campaign_creation_performed"])

    def test_approved_post_is_only_ready_for_the_existing_publisher(self):
        approved_payload = {
            **post()["payload"],
            "requiresVisualReview": False,
            "tiktokSettings": {
                "content_preview_confirmed": True,
                "express_consent_given": True,
            },
        }
        row = post(status="approved", approved_by="owner", approved_at="2026-11-05T12:00:00Z",
                   payload=approved_payload)
        result = prepare_existing_drafts([candidate()], [row])
        self.assertEqual(result["drafts"][0]["status"], "ready_for_existing_publisher")
        self.assertFalse(result["publication_performed"])

    def test_rejects_other_products_nonvideos_and_untrusted_asset_urls(self):
        variants = [
            post(product_id="gid://shopify/Product/999"),
            post(payload={**post()["payload"], "format": "image"}),
            post(payload={**post()["payload"], "videoURL": "https://attacker.example/video.mp4"}),
            post(payload={**post()["payload"], "importedMedia": False}),
        ]
        result = prepare_existing_drafts([candidate()], variants)
        self.assertEqual(result["status"], "no_existing_videos")
        self.assertEqual(result["prepared_count"], 0)

    def test_only_one_existing_draft_per_product_is_prepared(self):
        newer_draft = post(id="newer", created_at="2026-11-05T12:00:00Z")
        older_approved = post(
            id="approved",
            status="approved",
            approved_by="owner",
            approved_at="2026-11-05T10:00:00Z",
            created_at="2026-11-05T09:00:00Z",
            payload={**post()["payload"], "requiresVisualReview": False,
                     "tiktokSettings": {"content_preview_confirmed": True,
                                        "express_consent_given": True}},
        )
        result = prepare_existing_drafts([candidate()], [newer_draft, older_approved])
        self.assertEqual(result["prepared_count"], 1)
        self.assertEqual(result["drafts"][0]["post_id"], "approved")

    def test_rejects_non_homestro_product_destination(self):
        product = {**candidate(), "url": "https://attacker.example/products/test"}
        self.assertEqual(
            prepare_existing_drafts([product], [post()])["prepared_count"], 0
        )

    def test_agent_reads_only_the_existing_queue_and_never_posts(self):
        client = FakeClient({"draft_queued": [post()], "approved": []})
        result = asyncio.run(run_once([candidate()], env={"PILOT_ORGANIC_API_KEY": "test-key"}, client=client))
        self.assertEqual(result["prepared_count"], 1)
        self.assertEqual(len(client.calls), 2)
        self.assertTrue(all(call[1]["status"] in {"draft_queued", "approved"} for call in client.calls))
        self.assertTrue(all(call[2]["Authorization"] == "Bearer test-key" for call in client.calls))
        self.assertFalse(result["publication_performed"])
        self.assertFalse(result["ad_mutations_performed"])

    def test_missing_existing_publisher_key_is_a_blocker_and_does_not_fetch(self):
        client = FakeClient({})
        result = asyncio.run(run_once([candidate()], env={}, client=client))
        self.assertEqual(result["reason"], "PILOT_ORGANIC_API_KEY_UNAVAILABLE")
        self.assertEqual(client.calls, [])

    def test_empty_candidate_set_does_not_contact_pilot(self):
        client = FakeClient({})
        result = asyncio.run(run_once([], env={"PILOT_ORGANIC_API_KEY": "test-key"}, client=client))
        self.assertEqual(result["status"], "no_candidates")
        self.assertEqual(client.calls, [])

    def test_orchestrator_runs_tiktok_preparation_after_creative_and_before_metrics(self):
        calls = []
        product = {"id": PRODUCT_ID}

        async def hunter(env):
            calls.append("product_hunter")
            return {"status": "selected", "candidates": [product]}

        async def creative(products, *, env):
            calls.append("creative_seo")
            return {"status": "drafted", "draft_count": 1, "drafts": []}

        async def tiktok(products, *, env):
            calls.append("tiktok_publisher")
            return {"status": "prepared", "candidate_count": 1, "prepared_count": 1,
                    "ready_count": 1, "review_count": 0, "drafts": []}

        async def buyer(*, env):
            calls.append("media_buyer")
            return {"status": "collected", "metrics": []}

        async def run():
            with patch.object(orchestrator.product_hunter, "run_once", hunter), \
                    patch.object(orchestrator.creative_seo, "run_once", creative), \
                    patch.object(orchestrator.tiktok_publisher, "run_once", tiktok), \
                    patch.object(orchestrator.media_buyer, "run_once", buyer):
                return await orchestrator.run_once({})

        result = asyncio.run(run())
        self.assertEqual(calls, ["product_hunter", "creative_seo", "tiktok_publisher", "media_buyer"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["log_record"]["stages"]["tiktok_publisher"]["ready_count"], 1)
        self.assertFalse(result["log_record"]["publication_performed"])
        self.assertFalse(result["log_record"]["ad_mutations_performed"])


if __name__ == "__main__":
    unittest.main()
