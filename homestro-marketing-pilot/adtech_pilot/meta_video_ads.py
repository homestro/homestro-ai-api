"""Durable Higgsfield-to-Meta video handoff; no generation and no campaign creation."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from contextlib import closing
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx

from .media_registry import MediaRegistry, _exact_variant_id

TERMINAL = {"FAILED", "BLOCKED_MAPPING"}
VIDEO_HOST = "d8j0ntlcm91z4.cloudfront.net"


class MetaVideoQueue:
    def __init__(self, audit, *, env=None):
        self.audit = audit
        self.env = env if env is not None else os.environ
        with closing(audit._connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pilot_video_ad_queue(
                  job_id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, state TEXT NOT NULL,
                  video_id TEXT, creative_id TEXT, ad_id TEXT, last_error TEXT,
                  updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS pilot_higgsfield_video_events(
                  webhook_id TEXT PRIMARY KEY, variant_id TEXT, payload TEXT NOT NULL,
                  state TEXT NOT NULL, received_at TEXT NOT NULL);
            """)

    @staticmethod
    def _now():
        return datetime.now(UTC).isoformat()

    def health(self):
        with closing(self.audit._connect()) as db:
            rows = db.execute("SELECT state,COUNT(*) FROM pilot_video_ad_queue GROUP BY state").fetchall()
        counts = {str(state): int(count) for state, count in rows}
        active = str(self.env.get("PILOT_DAEMON_ENABLED", "true")).lower() == "true"
        return {
            "worker_status": "ACTIVE" if active else "STOPPED",
            "phase": "PROCESSING" if counts.get("QUEUED", 0) or counts.get("UPLOADING", 0)
                     or counts.get("META_VIDEO_PROCESSING", 0) or counts.get("META_REVIEW_PENDING", 0) else "IDLE",
            "queued": counts.get("QUEUED", 0),
            "processing": counts.get("UPLOADING", 0) + counts.get("META_VIDEO_PROCESSING", 0) + counts.get("META_REVIEW_PENDING", 0),
            "meta_review_pending": counts.get("META_REVIEW_PENDING", 0),
            "active": counts.get("ACTIVE", 0),
            "ads_created_after_video_ready": True,
            "meta_review_gates_delivery": True,
            "blocked": counts.get("BLOCKED_MAPPING", 0) + counts.get("FAILED", 0),
            "higgsfield_webhook_configured": bool(self.env.get("HIGGSFIELD_WEBHOOK_SECRET")),
            "ads_created_paused": False,
            "campaign_or_adset_creation": False,
            "generation_performed": False,
        }

    def record_webhook(self, webhook_id, variant_id, payload):
        variant = None
        if variant_id:
            variant = _exact_variant_id(variant_id)
        with closing(self.audit._connect()) as db, db:
            cur = db.execute(
                "INSERT OR IGNORE INTO pilot_higgsfield_video_events VALUES(?,?,?,?,?)",
                (webhook_id, variant, json.dumps(payload), "RECEIVED", self._now()),
            )
            return {"accepted": bool(cur.rowcount), "duplicate": not bool(cur.rowcount)}

    async def process_webhooks(self, products, registry):
        with closing(self.audit._connect()) as db:
            rows = db.execute(
                "SELECT webhook_id,variant_id,payload FROM pilot_higgsfield_video_events "
                "WHERE state='RECEIVED' ORDER BY received_at LIMIT 20"
            ).fetchall()
        processed = []
        by_variant = {str(item.get("id", "")).rsplit("/", 1)[-1]: item for item in products}
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=8), follow_redirects=False) as client:
            for webhook_id, variant_id, raw in rows:
                try:
                    event = json.loads(raw)
                    data = event.get("payload") or {}
                    video = data.get("video") or {}
                    url = str(video.get("url") or "")
                    parsed = urlsplit(url)
                    numeric = str(variant_id or "").rsplit("/", 1)[-1]
                    product = by_variant.get(numeric)
                    if (event.get("status") != "completed" or not product or
                        product.get("availability") != "in_stock" or
                        parsed.scheme != "https" or parsed.hostname != VIDEO_HOST):
                        state = "BLOCKED_MAPPING"
                        detail = "COMPLETED_VIDEO_WITH_EXACT_IN_STOCK_VARIANT_REQUIRED"
                    else:
                        record = {
                            "provider": "higgsfield", "job_id": str(event.get("request_id") or webhook_id),
                            "status": "completed", "kind": "video", "url": url,
                            "shopify_variant_id": variant_id,
                        }
                        await registry.import_one(record, products, client=client)
                        state, detail = "IMPORTED", None
                except Exception as exc:
                    state, detail = "FAILED", type(exc).__name__
                with closing(self.audit._connect()) as db, db:
                    db.execute("UPDATE pilot_higgsfield_video_events SET state=? WHERE webhook_id=?",
                               (state, webhook_id))
                processed.append({"state": state, "reason": detail})
        return {"processed": len(processed), "results": processed}

    async def cycle(self, media_rows, products):
        eligible = []
        by_id = {str(p.get("id", "")).rsplit("/", 1)[-1]: p for p in products}
        with closing(self.audit._connect()) as db, db:
            for media in media_rows:
                if media.get("kind") != "video" or not media.get("file_available"):
                    continue
                matches = media.get("matched_product_ids") or []
                variant_id = media.get("shopify_variant_id")
                product = by_id.get(str(variant_id or "").rsplit("/", 1)[-1])
                if len(matches) != 1 or not variant_id or not product or product.get("availability") != "in_stock":
                    state = "BLOCKED_MAPPING"
                    db.execute(
                        "INSERT INTO pilot_video_ad_queue VALUES(?,?,?,?,?,?,?,?) "
                        "ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at",
                        (media["job_id"], str(variant_id or ""), state, None, None, None,
                         "EXACT_IN_STOCK_SHOPIFY_VARIANT_REQUIRED", self._now()),
                    )
                    continue
                db.execute(
                    "INSERT OR IGNORE INTO pilot_video_ad_queue VALUES(?,?,?,?,?,?,?,?)",
                    (media["job_id"], variant_id, "QUEUED", None, None, None, None, self._now()),
                )
                row = db.execute("SELECT * FROM pilot_video_ad_queue WHERE job_id=?", (media["job_id"],)).fetchone()
                eligible.append((media, product, row))
        if not eligible:
            return {**self.health(), "processed": 0, "reason": "NO_EXACTLY_MAPPED_AVAILABLE_VIDEO"}
        if not self.env.get("META_ACCESS_TOKEN") or not self.env.get("META_AD_ACCOUNT_ID") or not self.env.get("META_PAGE_ID"):
            return {**self.health(), "processed": 0, "reason": "META_VIDEO_CREDENTIALS_NOT_CONFIGURED"}
        if not (self.env.get("PILOT_FIRST_PURCHASE_TEST_AUTHORIZED", "").lower() == "true"
                and self.env.get("PILOT_FIRST_PURCHASE_ACTIVATION_ENABLED", "").lower() == "true"):
            return {**self.health(), "processed": 0, "reason": "EXISTING_TEST_AUTHORIZATION_REQUIRED"}
        if self.env.get("DRY_RUN", "true").lower() == "true" or self.env.get("PILOT_AD_DRY_RUN", "true").lower() == "true":
            return {**self.health(), "processed": 0, "reason": "META_DRY_RUN_ENABLED"}

        token = self.env["META_ACCESS_TOKEN"].strip()
        account = self.env["META_AD_ACCOUNT_ID"].strip().removeprefix("act_")
        campaign = self.env.get("PILOT_FIRST_PURCHASE_CAMPAIGN_ID", "").strip()
        page = self.env["META_PAGE_ID"].strip()
        version = self.env.get("META_API_VERSION", "v26.0").strip()
        if not re.fullmatch(r"\d{4,30}", account) or not re.fullmatch(r"\d{4,30}", campaign) or not re.fullmatch(r"v\d+\.\d+", version):
            return {**self.health(), "processed": 0, "reason": "META_VIDEO_CONFIGURATION_INVALID"}
        headers = {"Authorization": f"Bearer {token}"}
        base = f"https://graph.facebook.com/{version}"
        timeout = httpx.Timeout(40, connect=8)
        outcomes = []
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            try:
                camp_resp = await client.get(f"{base}/{campaign}", headers=headers, params={"fields": "id,status"})
                camp_resp.raise_for_status()
                if str(camp_resp.json().get("status", "")).upper() != "ACTIVE":
                    return {**self.health(), "processed": 0, "reason": "EXISTING_CAMPAIGN_NOT_ACTIVE"}
                set_resp = await client.get(f"{base}/{campaign}/adsets", headers=headers,
                                            params={"fields": "id,status,effective_status,daily_budget", "limit": 50})
                set_resp.raise_for_status()
                sets = set_resp.json().get("data", [])
                active_sets = [x for x in sets if x.get("status") == "ACTIVE" and
                               x.get("effective_status", "ACTIVE") == "ACTIVE" and re.fullmatch(r"\d{4,30}", str(x.get("id", "")))]
                if len(active_sets) != 1:
                    return {**self.health(), "processed": 0, "reason": "UNIQUE_ACTIVE_EXISTING_ADSET_REQUIRED"}
                adset_id = str(active_sets[0]["id"])
                if active_sets[0].get("daily_budget") and int(active_sets[0]["daily_budget"]) > 500:
                    return {**self.health(), "processed": 0, "reason": "EXISTING_ADSET_BUDGET_EXCEEDS_EUR_5"}
                product_set_id = str(self.env.get("META_PRODUCT_SET_ID", "")).strip()
                if not re.fullmatch(r"\d{4,30}", product_set_id):
                    return {**self.health(), "processed": 0, "reason": "META_PRODUCT_SET_ID_REQUIRED"}
            except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
                return {**self.health(), "processed": 0, "reason": "META_PREFLIGHT_" + type(exc).__name__}

            for media, product, row in eligible:
                job, variant = media["job_id"], str(media["shopify_variant_id"])
                state, video_id, creative_id, ad_id, last_error = row[2], row[3], row[4], row[5], row[6]
                variant_key = variant.rsplit("/", 1)[-1]
                if variant_key != str(product.get("id", "")).rsplit("/", 1)[-1]:
                    self._save(job, variant, "BLOCKED_MAPPING", video_id, creative_id, ad_id, "EXACT_SHOPIFY_VARIANT_MISMATCH")
                    outcomes.append({"state": "BLOCKED_MAPPING", "reason": "EXACT_SHOPIFY_VARIANT_MISMATCH"})
                    continue
                if state == "FAILED" and not (video_id and (last_error == "HTTPStatusError" or str(last_error or "").startswith("META_HTTP_"))):
                    outcomes.append({"state": "FAILED", "reason": "RETRY_REQUIRES_SAVED_META_VIDEO_ID"})
                    continue
                if state == "BLOCKED_MAPPING" or state == "OWNER_PAUSED":
                    outcomes.append({"state": state})
                    continue
                stage = "video_upload"
                try:
                    if state == "UPLOADING" and not video_id:
                        self._save(job, variant, "FAILED", video_id, creative_id, ad_id, "UPLOAD_OUTCOME_UNKNOWN")
                        outcomes.append({"state": "FAILED", "reason": "UPLOAD_OUTCOME_UNKNOWN"})
                        continue
                    if not video_id:
                        self._save(job, variant, "UPLOADING", video_id, creative_id, ad_id, None)
                        local = MediaRegistry(self.audit).root / (media["sha256"] + ".mp4")
                        if not local.is_file():
                            raise ValueError("LOCAL_MP4_MISSING")
                        with local.open("rb") as source:
                            upload = await client.post(
                                f"{base}/act_{account}/advideos", headers=headers,
                                data={"name": f"homestro_hf_{job}", "description": f"Shopify variant {variant}"},
                                files={"source": ("creative.mp4", source, "video/mp4")},
                            )
                        upload.raise_for_status()
                        video_id = str(upload.json().get("id", ""))
                        if not re.fullmatch(r"\d{4,30}", video_id):
                            raise ValueError("META_VIDEO_ID_MISSING")
                        state = "META_VIDEO_PROCESSING"
                        self._save(job, variant, state, video_id, creative_id, ad_id, None)
                    stage = "video_status"
                    status_resp = await client.get(f"{base}/{video_id}", headers=headers, params={"fields": "status"})
                    status_resp.raise_for_status()
                    status = status_resp.json().get("status") or {}
                    video_status = str(status.get("video_status") or status.get("status") or "").lower()
                    if video_status not in {"ready", "complete", "completed"}:
                        self._save(job, variant, "META_VIDEO_PROCESSING", video_id, creative_id, ad_id, None)
                        outcomes.append({"state": "META_VIDEO_PROCESSING"})
                        continue
                    if not product.get("image_link"):
                        raise ValueError("PRODUCT_IMAGE_REQUIRED_FOR_VIDEO_STORY")
                    if not creative_id:
                        story = {"page_id": page, "video_data": {
                            "video_id": video_id,
                            "image_url": str(product.get("image_link") or ""),
                            "message": "Entdecke das Produkt bei Homestro.",
                            "title": str(product.get("title") or "Homestro")[:80],
                            "call_to_action": {"type": "SHOP_NOW", "value": {"link": str(product["link"])}}}}
                        stage = "creative_create"
                        response = await client.post(f"{base}/act_{account}/adcreatives", headers=headers,
                            data={"name": f"Homestro Video {job}", "object_story_spec": json.dumps(story),
                                  "product_set_id": product_set_id})
                        response.raise_for_status()
                        creative_id = str(response.json().get("id", ""))
                        if not re.fullmatch(r"\d{4,30}", creative_id):
                            raise ValueError("META_CREATIVE_ID_MISSING")
                    if not ad_id:
                        stage = "ad_create"
                        response = await client.post(f"{base}/act_{account}/ads", headers=headers,
                            data={"name": f"Homestro Video {job}", "adset_id": adset_id,
                                  "creative": json.dumps({"creative_id": creative_id, "product_set_id": product_set_id}),
                                  "product_set_id": product_set_id, "status": "ACTIVE"})
                        response.raise_for_status()
                        ad_id = str(response.json().get("id", ""))
                        if not re.fullmatch(r"\d{4,30}", ad_id):
                            raise ValueError("META_AD_ID_MISSING")
                    stage = "ad_readback"
                    readback = await client.get(f"{base}/{ad_id}", headers=headers,
                                                params={"fields": "id,status,effective_status"})
                    readback.raise_for_status()
                    remote = readback.json()
                    effective = str(remote.get("effective_status") or "").upper()
                    if effective == "ACTIVE":
                        final_state = "ACTIVE"
                    elif effective in {"PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"}:
                        final_state = "OWNER_PAUSED"
                    else:
                        final_state = "META_REVIEW_PENDING"
                    self._save(job, variant, final_state, video_id, creative_id, ad_id, None)
                    outcomes.append({"state": final_state, "meta_status": str(remote.get("status") or "")[:40],
                                     "meta_effective_status": effective[:40]})
                except httpx.HTTPStatusError as exc:
                    meta_code = None
                    meta_subcode = None
                    try:
                        error = exc.response.json().get("error", {})
                        meta_code = error.get("code")
                        meta_subcode = error.get("error_subcode")
                        meta_user_title = str(error.get("error_user_title") or "")[:120]
                        meta_user_msg = str(error.get("error_user_msg") or "")[:240]
                    except (ValueError, AttributeError):
                        meta_user_title = ""
                        meta_user_msg = ""
                    safe = f"META_HTTP_{exc.response.status_code}_CODE_{meta_code}_SUBCODE_{meta_subcode}_{stage}"
                    self._save(job, variant, "FAILED", video_id, creative_id, ad_id, safe)
                    outcomes.append({"state": "FAILED", "reason": "META_API_REJECTED",
                                     "http_status": exc.response.status_code,
                                     "meta_error_code": meta_code, "meta_error_subcode": meta_subcode, "stage": stage,
                                     "meta_user_title": meta_user_title, "meta_user_message": meta_user_msg})
                except (httpx.HTTPError, OSError, ValueError, TypeError) as exc:
                    self._save(job, variant, "FAILED", video_id, creative_id, ad_id, type(exc).__name__)
                    outcomes.append({"state": "FAILED", "reason": type(exc).__name__})
        return {**self.health(), "processed": len(outcomes), "results": outcomes}

    def _save(self, job, variant, state, video, creative, ad, error):
        with closing(self.audit._connect()) as db, db:
            db.execute(
                "INSERT INTO pilot_video_ad_queue VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(job_id) DO UPDATE SET variant_id=excluded.variant_id,state=excluded.state,"
                "video_id=excluded.video_id,creative_id=excluded.creative_id,ad_id=excluded.ad_id,"
                "last_error=excluded.last_error,updated_at=excluded.updated_at",
                (job, variant, state, video, creative, ad, error, self._now()),
            )
