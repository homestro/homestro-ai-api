"""Prepare existing, reviewed TikTok video drafts for the Pilot's sole publisher.

This agent deliberately does not generate media or call a posting endpoint. The
marketing Pilot already owns TikTok consent, review, rate limits and publishing;
creating a second publisher here could post the same video twice.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

PILOT_SOURCE = Path(__file__).resolve().parents[1] / "homestro-marketing-pilot"
if str(PILOT_SOURCE) not in sys.path:
    sys.path.insert(0, str(PILOT_SOURCE))

from adtech_pilot.organic_bridge import ORIGIN  # noqa: E402

logger = logging.getLogger("homestro.agents.tiktok_publisher")
MAX_RESPONSE_BYTES = 1_000_000
VIDEO_PATH = re.compile(r"^/marketing-assets/[a-f0-9]{64}\.mp4$")


def _trusted_video_url(value: Any) -> bool:
    try:
        url = urlsplit(str(value))
        origin = urlsplit(ORIGIN)
    except ValueError:
        return False
    return (
        url.scheme == "https"
        and url.hostname == origin.hostname
        and url.port in (None, 443)
        and not url.username
        and not url.password
        and not url.query
        and not url.fragment
        and bool(VIDEO_PATH.fullmatch(url.path))
    )


def _trusted_product_url(value: Any) -> bool:
    try:
        url = urlsplit(str(value))
        port = url.port
    except ValueError:
        return False
    return (
        url.scheme == "https"
        and url.hostname in {"homestro.de", "www.homestro.de"}
        and port in (None, 443)
        and not url.username
        and not url.password
        and url.path.startswith("/products/")
        and not url.query
        and not url.fragment
    )


def _selected_ids(candidates: list[dict[str, Any]]) -> set[str]:
    return {
        str(product.get("id"))
        for product in candidates
        if isinstance(product, dict) and product.get("id")
    }


def prepare_existing_drafts(
    candidates: list[dict[str, Any]], posts: list[dict[str, Any]]
) -> dict[str, Any]:
    """Match verified vertical-video drafts to selected products without writes."""
    selected = _selected_ids(candidates)
    products = {
        str(product["id"]): product
        for product in candidates
        if isinstance(product, dict) and product.get("id")
    }
    prepared: list[dict[str, Any]] = []
    ordered_posts = sorted(
        posts,
        key=lambda row: (
            row.get("status") == "approved",
            str(row.get("approved_at") or row.get("created_at") or ""),
        ),
        reverse=True,
    )
    prepared_products: set[str] = set()
    for post in ordered_posts:
        if not isinstance(post, dict) or post.get("channel") != "tiktok":
            continue
        product_id = str(post.get("product_id") or "")
        payload = post.get("payload")
        if product_id not in selected or not isinstance(payload, dict):
            continue
        if product_id in prepared_products:
            continue
        if payload.get("importedMedia") is not True or payload.get("format") != "reels":
            continue
        video_url = payload.get("videoURL")
        caption = str(payload.get("caption") or payload.get("title") or "").strip()
        if (
            not _trusted_video_url(video_url)
            or not _trusted_product_url(products[product_id].get("url"))
            or not caption
            or len(caption) > 2200
        ):
            continue

        settings = payload.get("tiktokSettings")
        approved = (
            post.get("status") == "approved"
            and bool(post.get("approved_by"))
            and bool(post.get("approved_at"))
            and payload.get("requiresVisualReview") is not True
            and isinstance(settings, dict)
            and settings.get("content_preview_confirmed") is True
            and settings.get("express_consent_given") is True
        )
        product = products[product_id]
        prepared_products.add(product_id)
        prepared.append(
            {
                "post_id": str(post.get("id") or ""),
                "product_id": product_id,
                "product_url": product.get("url"),
                "video_url": video_url,
                "format": "vertical_9_16_mp4",
                "caption": caption,
                "status": "ready_for_existing_publisher" if approved else "needs_tiktok_review",
                "content_posting_api": {
                    "title": caption,
                    "source": "PULL_FROM_URL",
                    "video_url": video_url,
                    "requires_verified_url_prefix": True,
                    "upload_performed": False,
                    "publication_performed": False,
                },
                "ads_material": {
                    "product_url": product.get("url"),
                    "caption": caption,
                    "video_url": video_url,
                    "daily_budget_eur": 0,
                    "campaign_creation_performed": False,
                    "requires_separate_owner_budget_authorization": True,
                },
            }
        )

    result_status = (
        "prepared"
        if prepared and all(row["status"] == "ready_for_existing_publisher" for row in prepared)
        else "needs_review" if prepared else "no_existing_videos"
    )
    return {
        "status": result_status,
        "candidate_count": len(selected),
        "prepared_count": len(prepared),
        "ready_count": sum(row["status"] == "ready_for_existing_publisher" for row in prepared),
        "review_count": sum(row["status"] == "needs_tiktok_review" for row in prepared),
        "drafts": prepared,
        "video_generation_performed": False,
        "upload_performed": False,
        "publication_performed": False,
        "ad_mutations_performed": False,
        "ad_spend_eur": 0,
    }


async def _read_social_posts(api_key: str, client: Any | None = None) -> list[dict[str, Any]]:
    own_client = client is None
    http = client or httpx.AsyncClient(
        timeout=httpx.Timeout(15, connect=5), follow_redirects=False
    )
    try:
        posts: list[dict[str, Any]] = []
        for status in ("draft_queued", "approved"):
            response = await http.get(
                f"{ORIGIN}/api/marketing/v2/social/posts",
                params={"status": status},
                headers={"Authorization": f"Bearer {api_key}"},
            )
            response.raise_for_status()
            if len(response.content) > MAX_RESPONSE_BYTES:
                raise ValueError("TIKTOK_QUEUE_RESPONSE_TOO_LARGE")
            rows = response.json()
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("INVALID_TIKTOK_QUEUE_RESPONSE")
            posts.extend(rows)
        return posts
    finally:
        if own_client:
            await http.aclose()


async def run_once(
    candidates: list[dict[str, Any]],
    *,
    env: dict[str, str] | None = None,
    client: Any | None = None,
) -> dict[str, Any]:
    """Read the existing queue and produce review/ad materials; make no writes."""
    env = os.environ if env is None else env
    if not candidates:
        return {"status": "no_candidates", "candidate_count": 0, "prepared_count": 0,
                "drafts": [], "publication_performed": False, "ad_mutations_performed": False}
    api_key = env.get("PILOT_ORGANIC_API_KEY", "").strip()
    if not api_key or api_key.startswith("${{"):
        result = {"status": "blocked", "reason": "PILOT_ORGANIC_API_KEY_UNAVAILABLE",
                  "candidate_count": len(candidates), "prepared_count": 0, "drafts": [],
                  "publication_performed": False, "ad_mutations_performed": False}
        logger.info("tiktok_publisher %s", json.dumps(result, separators=(",", ":")))
        return result
    try:
        posts = await _read_social_posts(api_key, client)
        result = prepare_existing_drafts(candidates, posts)
    except (httpx.HTTPError, ValueError, TypeError):
        result = {"status": "blocked", "reason": "EXISTING_TIKTOK_QUEUE_UNAVAILABLE",
                  "candidate_count": len(candidates), "prepared_count": 0, "drafts": [],
                  "publication_performed": False, "ad_mutations_performed": False}
    logger.info(
        "tiktok_publisher %s",
        json.dumps(
            {key: value for key, value in result.items() if key != "drafts"},
            separators=(",", ":"),
        ),
    )
    return result
