"""Prepare TikTok bundles and publish directly only when TikTok OAuth is configured.

No media generation is performed here. Without an authorized direct-post token,
the existing ready-to-post bundle is returned without blocking the pipeline.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit
from urllib import error as urlerror, request as urlrequest

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



def prepare_generated_bundle(
    product: dict[str, Any], video_url: str, caption: str, hashtags: list[str] | None = None
) -> dict[str, Any]:
    """Return a manual TikTok/Shorts bundle for a locally rendered MP4; never upload or publish."""
    url = str(product.get("url") or product.get("source_url") or "")
    caption = str(caption or "").strip()
    if not _trusted_product_url(url):
        return {"status": "blocked", "reason": "UNTRUSTED_PRODUCT_URL",
                "upload_performed": False, "publication_performed": False}
    if not _trusted_video_url(video_url):
        return {"status": "blocked", "reason": "UNTRUSTED_VIDEO_URL",
                "upload_performed": False, "publication_performed": False}
    if not caption or len(caption) > 2200:
        return {"status": "blocked", "reason": "INVALID_CAPTION",
                "upload_performed": False, "publication_performed": False}
    tags = [str(value).strip() for value in (hashtags or []) if str(value).strip()]
    return {"status": "ready_to_post", "product_id": str(product.get("id") or product.get("product_id") or ""),
            "product_url": url, "video_url": video_url, "format": "vertical_9_16_mp4",
            "platforms": ["TikTok", "YouTube Shorts"], "caption": caption, "hashtags": tags,
            "upload_performed": False, "publication_performed": False, "paid_ads_created": False,
            "ad_spend_eur": 0}


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



def _tiktok_request(url: str, *, method: str = "POST", token: str | None = None,
                    payload: dict[str, Any] | None = None, data: bytes | None = None,
                    headers: dict[str, str] | None = None, timeout: int = 25) -> dict[str, Any]:
    request_headers = dict(headers or {})
    if token:
        request_headers["Authorization"] = "Bearer " + token
    body = data
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json; charset=UTF-8")
    req = urlrequest.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            raw = response.read(2_000_000)
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urlerror.HTTPError as exc:
        body_text = exc.read(2000).decode("utf-8", errors="replace")
        try:
            detail = json.loads(body_text).get("error", {}).get("code", "HTTP_ERROR")
        except (ValueError, AttributeError):
            detail = "HTTP_ERROR"
        raise RuntimeError(f"TIKTOK_HTTP_{exc.code}_{str(detail)[:80]}") from None
    except (urlerror.URLError, TimeoutError, OSError, ValueError) as exc:
        raise RuntimeError(f"TIKTOK_REQUEST_{type(exc).__name__.upper()}") from None


def _tiktok_access_token(env: dict[str, str]) -> str:
    access = (env.get("TIKTOK_ACCESS_TOKEN") or "").strip()
    refresh = (env.get("TIKTOK_REFRESH_TOKEN") or "").strip()
    client_key = (env.get("TIKTOK_CLIENT_KEY") or "").strip()
    client_secret = (env.get("TIKTOK_CLIENT_SECRET") or "").strip()
    if access:
        return access
    if not (refresh and client_key and client_secret):
        return ""
    body = urlencode({
        "client_key": client_key, "client_secret": client_secret,
        "grant_type": "refresh_token", "refresh_token": refresh,
    }).encode("utf-8")
    req = urlrequest.Request("https://open.tiktokapis.com/v2/oauth/token/",
                             data=body, headers={"Content-Type": "application/x-www-form-urlencoded"},
                             method="POST")
    try:
        with urlrequest.urlopen(req, timeout=20) as response:
            data = json.loads(response.read(100_000).decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"TIKTOK_TOKEN_REFRESH_{type(exc).__name__.upper()}") from None
    token = str(data.get("data", {}).get("access_token") or "")
    if not token:
        raise RuntimeError("TIKTOK_TOKEN_REFRESH_REJECTED")
    return token


def publish_generated_video(
    video_path: str, caption: str, *, duration_seconds: int | None = None,
    env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Publish the locally rendered MP4 only when TikTok OAuth is configured."""
    env = os.environ if env is None else env
    zernio_key = str(env.get("ZERNIO_API_KEY") or "").strip()
    zernio_account = str(env.get("ZERNIO_TIKTOK_ACCOUNT_ID") or "").strip()
    if zernio_key or zernio_account:
        if not (zernio_key and zernio_account):
            return {"status": "ready_to_post", "reason": "ZERNIO_TIKTOK_CONFIGURATION_INCOMPLETE",
                    "upload_performed": False, "publication_performed": False}
        return _publish_video_via_zernio(video_path, caption, env=env)
    if not (str(env.get("TIKTOK_ACCESS_TOKEN") or "").strip()
            or (env.get("TIKTOK_REFRESH_TOKEN") and env.get("TIKTOK_CLIENT_KEY")
                and env.get("TIKTOK_CLIENT_SECRET"))):
        return {"status": "ready_to_post", "reason": "TIKTOK_OAUTH_NOT_CONFIGURED",
                "upload_performed": False, "publication_performed": False}
    path = Path(video_path)
    if not path.is_file():
        return {"status": "ready_to_post", "reason": "TIKTOK_VIDEO_FILE_MISSING",
                "upload_performed": False, "publication_performed": False}
    size = path.stat().st_size
    if size <= 0 or size > 60 * 1024 * 1024:
        return {"status": "ready_to_post", "reason": "TIKTOK_VIDEO_SIZE_OUT_OF_RANGE",
                "upload_performed": False, "publication_performed": False}
    try:
        token = _tiktok_access_token(env)
        creator = _tiktok_request(
            "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
            token=token, payload={},
        )
        error_data = creator.get("error") or {}
        if error_data.get("code") not in ("ok", "OK", None):
            raise RuntimeError("TIKTOK_CREATOR_INFO_" + str(error_data.get("code", "ERROR"))[:80])
        creator_info = creator.get("data") or {}
        privacy_options = creator_info.get("privacy_level_options") or []
        privacy = str(env.get("TIKTOK_PRIVACY_LEVEL") or "PUBLIC_TO_EVERYONE")
        if privacy not in privacy_options:
            return {"status": "ready_to_post", "reason": "TIKTOK_PRIVACY_LEVEL_NOT_AVAILABLE",
                    "privacy_options": privacy_options, "upload_performed": False,
                    "publication_performed": False}
        duration = int(creator_info.get("max_video_post_duration_sec") or 0)
        if duration and duration_seconds and duration < duration_seconds:
            return {"status": "ready_to_post", "reason": "TIKTOK_DURATION_LIMIT_TOO_LOW",
                    "max_duration_seconds": duration, "upload_performed": False,
                    "publication_performed": False}
        chunk_size = 10_000_000
        chunks = max(1, math.ceil(size / chunk_size))
        init = _tiktok_request(
            "https://open.tiktokapis.com/v2/post/publish/video/init/",
            token=token,
            payload={
                "post_info": {
                    "title": str(caption)[:2200], "privacy_level": privacy,
                    "disable_duet": False, "disable_comment": False, "disable_stitch": False,
                    "brand_content_toggle": False, "brand_organic_toggle": True,
                },
                "source_info": {
                    "source": "FILE_UPLOAD", "video_size": size,
                    "chunk_size": chunk_size, "total_chunk_count": chunks,
                },
            },
        )
        init_error = init.get("error") or {}
        if init_error.get("code") not in ("ok", "OK", None):
            raise RuntimeError("TIKTOK_INIT_" + str(init_error.get("code", "ERROR"))[:80])
        publish_id = str((init.get("data") or {}).get("publish_id") or "")
        upload_url = str((init.get("data") or {}).get("upload_url") or "")
        if not publish_id or not upload_url or not upload_url.startswith("https://"):
            raise RuntimeError("TIKTOK_UPLOAD_URL_OR_PUBLISH_ID_MISSING")
        upload_host = urlsplit(upload_url).hostname or ""
        if upload_host != "open-upload.tiktokapis.com":
            raise RuntimeError("TIKTOK_UPLOAD_HOST_REJECTED")
        with path.open("rb") as stream:
            start = 0
            while start < size:
                chunk = stream.read(chunk_size)
                if not chunk:
                    break
                end = start + len(chunk) - 1
                req = urlrequest.Request(upload_url, data=chunk, headers={
                    "Content-Type": "video/mp4", "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {start}-{end}/{size}",
                }, method="PUT")
                try:
                    with urlrequest.urlopen(req, timeout=90) as response:
                        response.read(2048)
                except Exception as exc:
                    raise RuntimeError(f"TIKTOK_UPLOAD_{type(exc).__name__.upper()}") from None
                start = end + 1
        status_result = _tiktok_request(
            "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
            token=token, payload={"publish_id": publish_id},
        )
        status_error = status_result.get("error") or {}
        if status_error.get("code") not in ("ok", "OK", None):
            raise RuntimeError("TIKTOK_STATUS_" + str(status_error.get("code", "ERROR"))[:80])
        status_data = status_result.get("data") or {}
        state = str(status_data.get("status") or "PROCESSING")
        if state != "PUBLISH_COMPLETE":
            return {"status": "processing" if state not in {"FAILED", "SEND_TO_USER_INBOX"} else "ready_to_post",
                    "reason": state, "publish_id": publish_id, "upload_performed": True,
                    "publication_performed": state == "PUBLISH_COMPLETE"}
        ids = status_data.get("publicaly_available_post_id") or []
        return {"status": "published", "publish_id": publish_id,
                "post_ids": ids, "upload_performed": True, "publication_performed": True}
    except Exception as exc:
        return {"status": "ready_to_post",
                "reason": str(exc)[:160], "upload_performed": False,
                "publication_performed": False}


def _publish_video_via_zernio(
    video_path: str, caption: str, *, env: dict[str, str]
) -> dict[str, Any]:
    """Use Homestro's existing Zernio-connected TikTok account."""
    if str(env.get("PILOT_SOCIAL_ENABLED", "true")).strip().lower() == "false" or \
       str(env.get("PILOT_SOCIAL_PUBLISH_ENABLED", "true")).strip().lower() == "false":
        return {"status": "ready_to_post", "reason": "PILOT_SOCIAL_PUBLISHING_DISABLED",
                "upload_performed": False, "publication_performed": False}
    path = Path(video_path)
    if not path.is_file():
        return {"status": "ready_to_post", "reason": "TIKTOK_VIDEO_FILE_MISSING",
                "upload_performed": False, "publication_performed": False}
    video_url = ORIGIN.rstrip("/") + "/marketing-assets/" + path.name
    if not _trusted_video_url(video_url):
        return {"status": "ready_to_post", "reason": "UNTRUSTED_ZERNIO_VIDEO_URL",
                "upload_performed": False, "publication_performed": False}
    account_id = str(env.get("ZERNIO_TIKTOK_ACCOUNT_ID") or "").strip()
    api_key = str(env.get("ZERNIO_API_KEY") or "").strip()
    privacy = str(env.get("TIKTOK_PRIVACY_LEVEL") or "PUBLIC_TO_EVERYONE").strip()
    payload = {
        "content": str(caption or "")[:2200],
        "mediaItems": [{"type": "video", "url": video_url}],
        "platforms": [{"platform": "tiktok", "accountId": account_id}],
        "tiktokSettings": {
            "privacy_level": privacy,
            "allow_comment": True,
            "allow_duet": True,
            "allow_stitch": True,
            "content_preview_confirmed": True,
            "express_consent_given": True,
            "commercialContentType": "brand_organic",
        },
        "publishNow": True,
    }
    idempotency_key = hashlib.sha256(("homestro-tiktok:" + path.stem).encode("utf-8")).hexdigest()
    req = urlrequest.Request(
        "https://zernio.com/api/v1/posts",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotency_key,
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=45) as response:
            status_code = int(response.status)
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RuntimeError("ZERNO_RESPONSE_TOO_LARGE")
        body = json.loads(raw.decode("utf-8")) if raw else {}
    except urlerror.HTTPError as exc:
        return {"status": "ready_to_post", "reason": f"ZERNO_HTTP_{exc.code}",
                "upload_performed": False, "publication_performed": False}
    except (urlerror.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"status": "ready_to_post", "reason": f"ZERNO_REQUEST_{type(exc).__name__.upper()}",
                "upload_performed": False, "publication_performed": False}
    if status_code < 200 or status_code >= 300:
        return {"status": "ready_to_post", "reason": f"ZERNO_HTTP_{status_code}",
                "upload_performed": False, "publication_performed": False}
    post = body.get("post") if isinstance(body, dict) else {}
    platforms = post.get("platforms") if isinstance(post, dict) else []
    result = next((row for row in platforms if row.get("platform") == "tiktok"), {}) if isinstance(platforms, list) else {}
    platform_status = str(result.get("status") or post.get("status") or "").lower()
    post_id = str(post.get("_id") or post.get("id") or "")
    if platform_status == "published":
        return {"status": "published", "post_id": post_id or None,
                "url": result.get("platformPostUrl"), "upload_performed": True,
                "publication_performed": True, "provider": "zernio"}
    if platform_status in {"processing", "queued", "scheduled", "publishing"}:
        return {"status": "processing", "post_id": post_id or None,
                "upload_performed": True, "publication_performed": False, "provider": "zernio"}
    error_message = str(result.get("errorMessage") or post.get("error") or "TIKTOK_NOT_PUBLISHED")[:140]
    return {"status": "ready_to_post", "reason": error_message,
            "post_id": post_id or None, "upload_performed": bool(post_id),
            "publication_performed": False, "provider": "zernio"}
