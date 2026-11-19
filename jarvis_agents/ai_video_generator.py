"""Cost-gated Higgsfield adapter used by the organic video pipeline.

Generation is opt-in, capped per UTC day, and skipped for products that already
have a Shopify video. Existing Shopify media and free FFmpeg rendering are separate.
"""
from __future__ import annotations

import os
import fcntl
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jarvis_agents import higgsfield_video_agent

ERAZER_XP6_HANDLE = "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5"

def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() == "true"


def max_daily_videos(env: Any = None) -> int:
    values = os.environ if env is None else env
    try:
        return max(0, min(int(values.get("MAX_DAILY_AI_VIDEOS", "1")), 100))
    except (TypeError, ValueError):
        return 0


def existing_shopify_video(product: dict[str, Any]) -> bool:
    return any(str(url or "").strip() for url in (product.get("video_urls") or []))


def _reserve_daily_slot(values: Any, today: str, limit: int) -> bool:
    """Persist the daily limit across restarts; a ledger error fails closed."""
    ledger = Path(str(values.get("AI_VIDEO_GENERATION_LEDGER_PATH") or "/data/jarvis-ai-video-daily.json"))
    ledger.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger.with_suffix(ledger.suffix + ".lock")
    try:
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                payload = json.loads(ledger.read_text(encoding="utf-8")) if ledger.exists() else {}
            except (OSError, ValueError):
                return False
            if not isinstance(payload, dict):
                return False
            try:
                used = int(payload.get("date") == today and payload.get("count", 0) or 0)
            except (TypeError, ValueError):
                return False
            if used >= limit:
                return False
            updated = json.dumps({"date": today, "count": used + 1}, separators=(",", ":"))
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=ledger.parent, delete=False) as temp:
                temp.write(updated)
                temp_path = Path(temp.name)
            temp_path.replace(ledger)
            return True
    except OSError:
        return False


def generate_video(
    product: dict[str, Any], hook: str, output_path: Path, *, env: Any = None,
) -> dict[str, Any]:
    """Generate only when explicitly enabled, under quota, and without Shopify video."""
    values = os.environ if env is None else env
    if str(product.get("handle") or "").casefold() == ERAZER_XP6_HANDLE:
        return {"status": "skipped", "reason": "ERAZER_XP6_SHOPIFY_VIDEO_REUSE_ONLY", "generated": False}
    if existing_shopify_video(product):
        return {"status": "skipped", "reason": "SHOPIFY_VIDEO_ALREADY_AVAILABLE", "generated": False}
    if not _truthy(values.get("AI_VIDEO_GENERATION_ENABLED", "false")):
        return {"status": "disabled", "reason": "AI_VIDEO_GENERATION_DISABLED", "generated": False}
    if not higgsfield_video_agent.is_enabled(values):
        return {"status": "disabled", "reason": "HIGGSFIELD_NOT_CONFIGURED", "generated": False}

    today = datetime.now(timezone.utc).date().isoformat()
    image_urls = product.get("image_urls") or []
    if not image_urls:
        return {"status": "blocked", "reason": "SHOPIFY_PRODUCT_IMAGE_MISSING", "generated": False}
    if max_daily_videos(values) <= 0 or not _reserve_daily_slot(values, today, max_daily_videos(values)):
        return {"status": "blocked", "reason": "MAX_DAILY_AI_VIDEOS_REACHED", "generated": False}
    return higgsfield_video_agent.generate_video(
        image_url=str(image_urls[0]),
        prompt=higgsfield_video_agent.build_story_prompt(product, hook),
        output_path=output_path,
        env=values,
    )
