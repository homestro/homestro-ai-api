"""Zero-cost local MP4 upload to YouTube Data API v3; no paid media generation."""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib import error, parse, request
from typing import Any

MAX_VIDEO_BYTES = 60 * 1024 * 1024
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"


def _read_json(response: Any) -> dict[str, Any]:
    data = response.read(2_000_000)
    result = json.loads(data.decode("utf-8")) if data else {}
    return result if isinstance(result, dict) else {}


def _refresh_access_token(env: dict[str, str]) -> str:
    form = parse.urlencode({
        "client_id": env["YOUTUBE_CLIENT_ID"],
        "client_secret": env["YOUTUBE_CLIENT_SECRET"],
        "refresh_token": env["YOUTUBE_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = request.Request(TOKEN_URL, data=form, headers={
        "Content-Type": "application/x-www-form-urlencoded",
    }, method="POST")
    try:
        with request.urlopen(req, timeout=20) as response:
            result = _read_json(response)
    except error.HTTPError as exc:
        raise RuntimeError(f"YOUTUBE_TOKEN_HTTP_{exc.code}") from None
    except (error.URLError, TimeoutError, OSError, ValueError):
        raise RuntimeError("YOUTUBE_TOKEN_REFRESH_FAILED") from None
    token = str(result.get("access_token") or "")
    if not token:
        raise RuntimeError("YOUTUBE_ACCESS_TOKEN_MISSING")
    return token


def publish_video(
    video_path: str, title: str, description: str, *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Upload a Shorts-ready local MP4 and publish it at the requested privacy."""
    env = os.environ if env is None else env
    required = ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")
    if any(not str(env.get(key) or "").strip() for key in required):
        return {"status": "ready_to_post", "reason": "YOUTUBE_OAUTH_NOT_CONFIGURED",
                "upload_performed": False, "publication_performed": False}
    path = Path(video_path)
    if not path.is_file():
        return {"status": "ready_to_post", "reason": "YOUTUBE_VIDEO_FILE_MISSING",
                "upload_performed": False, "publication_performed": False}
    size = path.stat().st_size
    if size <= 0 or size > MAX_VIDEO_BYTES:
        return {"status": "ready_to_post", "reason": "YOUTUBE_VIDEO_SIZE_OUT_OF_RANGE",
                "upload_performed": False, "publication_performed": False}
    safe_title = str(title or "Homestro Produktvideo #Shorts").strip()[:100]
    safe_description = str(description or "").strip()[:5000]
    privacy = str(env.get("YOUTUBE_PRIVACY_STATUS") or "public").strip().lower()
    if privacy not in {"public", "unlisted", "private"}:
        return {"status": "ready_to_post", "reason": "YOUTUBE_PRIVACY_STATUS_INVALID",
                "upload_performed": False, "publication_performed": False}
    try:
        token = _refresh_access_token(env)
        query = parse.urlencode({"uploadType": "resumable", "part": "snippet,status"})
        metadata = {
            "snippet": {
                "title": safe_title,
                "description": safe_description,
                "categoryId": str(env.get("YOUTUBE_CATEGORY_ID") or "22"),
            },
            "status": {
                "privacyStatus": privacy,
                "selfDeclaredMadeForKids": False,
            },
        }
        init_request = request.Request(
            f"{UPLOAD_URL}?{query}",
            data=json.dumps(metadata).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Length": str(size),
                "X-Upload-Content-Type": "video/mp4",
            },
            method="POST",
        )
        try:
            with request.urlopen(init_request, timeout=30) as response:
                upload_uri = response.headers.get("Location")
        except error.HTTPError as exc:
            raise RuntimeError(f"YOUTUBE_UPLOAD_INIT_HTTP_{exc.code}") from None
        except (error.URLError, TimeoutError, OSError):
            raise RuntimeError("YOUTUBE_UPLOAD_INIT_FAILED") from None
        if not upload_uri or not upload_uri.startswith("https://"):
            raise RuntimeError("YOUTUBE_RESUMABLE_URI_MISSING")
        video_bytes = path.read_bytes()
        if len(video_bytes) != size:
            raise RuntimeError("YOUTUBE_VIDEO_CHANGED_DURING_UPLOAD")
        upload_request = request.Request(upload_uri, data=video_bytes, headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "video/mp4",
            "Content-Length": str(size),
        }, method="PUT")
        try:
            with request.urlopen(upload_request, timeout=180) as response:
                result = _read_json(response)
        except error.HTTPError as exc:
            raise RuntimeError(f"YOUTUBE_UPLOAD_HTTP_{exc.code}") from None
        except (error.URLError, TimeoutError, OSError, ValueError):
            raise RuntimeError("YOUTUBE_UPLOAD_FAILED") from None
        video_id = str(result.get("id") or "")
        if not video_id:
            raise RuntimeError("YOUTUBE_VIDEO_ID_MISSING")
        return {
            "status": "published" if privacy == "public" else "uploaded",
            "video_id": video_id,
            "url": f"https://www.youtube.com/shorts/{video_id}",
            "privacy_status": privacy,
            "upload_performed": True,
            "publication_performed": privacy == "public",
        }
    except Exception as exc:
        return {"status": "ready_to_post",
                "reason": str(exc)[:160],
                "upload_performed": False, "publication_performed": False}
