"""Optional, explicitly enabled Higgsfield image-to-video client.

This module makes no request unless both HIGGSFIELD_ENABLED=true and an API credential
are present. It never logs credentials or signed media URLs. All failures are returned
to the caller so the free Shopify-video/Ken-Burns fallback can continue.
"""
from __future__ import annotations

import ipaddress
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API_BASE = "https://api.higgsfield.ai"
CREATE_URL = f"{API_BASE}/kling-video/v3.0-turbo/image-to-video"
MAX_VIDEO_BYTES = 150 * 1024 * 1024


def is_enabled(env: Any = None) -> bool:
    values = os.environ if env is None else env
    return (
        str(values.get("HIGGSFIELD_ENABLED", "")).strip().lower() == "true"
        and bool(str(values.get("HIGGSFIELD_API_KEY", "")).strip())
    )


def build_story_prompt(product: dict[str, Any], hook: str) -> str:
    title = " ".join(str(product.get("title") or "Homestro Produkt").split())[:120]
    safe_hook = " ".join(str(hook or "").split())[:140]
    return (
        "Erzeuge ein hochwertiges, emotionales deutsches 9:16 Kurzvideo als "
        "Problem-Rescue-Erleichterung-Erzählung. Szene 1 zeigt einen glaubwürdigen "
        "Alltagsmoment mit Unsicherheit oder Frust, Szene 2 zeigt das Produkt "
        "natürlich im Einsatz, Szene 3 vermittelt Ruhe und Selbstvertrauen. "
        f"Produkt: {title}. Dramatischer Hook als Stimmungsvorgabe: {safe_hook}. "
        "Das gezeigte Produkt muss dem Referenzbild entsprechen. Keine erfundenen "
        "technischen Eigenschaften, keine medizinischen oder rechtlichen Versprechen, "
        "keine lesbaren Texte, Logos, Preise oder zusätzlichen Produkte im Bild. "
        "Realistische Bewegung, warme filmische Beleuchtung, klare Produktaufnahme."
    )


def _validate_public_https_url(url: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(str(url or ""))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("UNSAFE_HIGGSFIELD_MEDIA_URL")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise ValueError("UNSAFE_HIGGSFIELD_MEDIA_URL")
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            raise ValueError("UNSAFE_HIGGSFIELD_MEDIA_URL")
    except ValueError as exc:
        if str(exc) == "UNSAFE_HIGGSFIELD_MEDIA_URL":
            raise
        try:
            resolved = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except OSError as dns_error:
            raise ValueError("HIGGSFIELD_MEDIA_HOST_UNRESOLVABLE") from dns_error
        if any(not ipaddress.ip_address(item[4][0]).is_global for item in resolved):
            raise ValueError("UNSAFE_HIGGSFIELD_MEDIA_URL")
    return parsed


class _PublicHttpsRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_public_https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _request_json(url: str, credential: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Key {credential.removeprefix('Key ').strip()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "HomestroHiggsfieldVideo/1.0",
        },
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("INVALID_HIGGSFIELD_RESPONSE")
    return result


def _download_video(url: str, output_path: Path) -> None:
    _validate_public_https_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "HomestroHiggsfieldVideo/1.0"})
    opener = urllib.request.build_opener(_PublicHttpsRedirectHandler())
    with opener.open(request, timeout=60) as response, output_path.open("wb") as target:
        _validate_public_https_url(response.geturl())
        length = int(response.headers.get("Content-Length") or "0")
        if length > MAX_VIDEO_BYTES:
            raise ValueError("HIGGSFIELD_VIDEO_TOO_LARGE")
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_VIDEO_BYTES:
                raise ValueError("HIGGSFIELD_VIDEO_TOO_LARGE")
            target.write(chunk)
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise ValueError("EMPTY_HIGGSFIELD_VIDEO")


def generate_video(
    image_url: str,
    prompt: str,
    output_path: str | Path,
    env: Any = None,
    poll_interval_seconds: float = 5.0,
    max_wait_seconds: float = 600.0,
) -> dict[str, Any]:
    values = os.environ if env is None else env
    if str(values.get("HIGGSFIELD_ENABLED", "")).strip().lower() != "true":
        return {"status": "disabled", "reason": "HIGGSFIELD_DISABLED"}
    credential = str(values.get("HIGGSFIELD_API_KEY") or "").strip()
    if not credential:
        return {"status": "disabled", "reason": "HIGGSFIELD_API_KEY_MISSING"}
    try:
        _validate_public_https_url(image_url)
        created = _request_json(
            CREATE_URL,
            credential,
            {"prompt": prompt, "duration": 10, "image_url": image_url, "resolution": "720p"},
        )
        request_id = str(created.get("request_id") or created.get("id") or "").strip()
        if not request_id:
            raise ValueError("HIGGSFIELD_REQUEST_ID_MISSING")
        status_url = f"{API_BASE}/requests/{urllib.parse.quote(request_id, safe='')}/status"
        deadline = time.monotonic() + max(1.0, float(max_wait_seconds))
        state = str(created.get("status") or "").lower()
        result = created
        while state not in {"completed", "failed", "nsfw", "canceled", "cancelled"}:
            if time.monotonic() >= deadline:
                return {"status": "fallback", "reason": "HIGGSFIELD_RENDER_TIMEOUT"}
            time.sleep(max(0.5, float(poll_interval_seconds)))
            result = _request_json(status_url, credential)
            state = str(result.get("status") or "").lower()
        if state != "completed":
            return {"status": "fallback", "reason": f"HIGGSFIELD_RENDER_{state.upper() or 'FAILED'}"}
        video = result.get("video")
        video_url = video.get("url") if isinstance(video, dict) else video
        if not video_url:
            video_url = result.get("video_url") or result.get("url")
        if not isinstance(video_url, str) or not video_url:
            return {"status": "fallback", "reason": "HIGGSFIELD_VIDEO_URL_MISSING"}
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        _download_video(video_url, path)
        return {"status": "completed", "path": str(path), "request_id": request_id}
    except urllib.error.HTTPError as error:
        # Do not propagate provider errors (including empty-credit responses) into the pipeline.
        return {"status": "fallback", "reason": "HIGGSFIELD_HTTP_ERROR", "http_status": error.code}
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return {"status": "fallback", "reason": "HIGGSFIELD_GENERATION_UNAVAILABLE"}
