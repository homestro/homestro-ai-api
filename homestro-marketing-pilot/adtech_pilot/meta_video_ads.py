"""Durable Higgsfield-to-Meta video handoff; no generation and no campaign creation."""
from __future__ import annotations

import asyncio
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
                                            params={"fields": "id,status,effective_status,daily_budget,promoted_object", "limit": 50})
                set_resp.raise_for_status()
                sets = set_resp.json().get("data", [])
                active_sets = [x for x in sets if x.get("status") == "ACTIVE" and
                               x.get("effective_status", "ACTIVE") == "ACTIVE" and re.fullmatch(r"\d{4,30}", str(x.get("id", "")))]
                if len(active_sets) != 1:
                    return {**self.health(), "processed": 0, "reason": "UNIQUE_ACTIVE_EXISTING_ADSET_REQUIRED"}
                adset_id = str(active_sets[0]["id"])
                if active_sets[0].get("daily_budget") and int(active_sets[0]["daily_budget"]) > 500:
                    return {**self.health(), "processed": 0, "reason": "EXISTING_ADSET_BUDGET_EXCEEDS_EUR_5"}
                adset_promoted = active_sets[0].get("promoted_object") or {}
                product_set_id = str(adset_promoted.get("product_set_id") or "").strip()
                configured_set = str(self.env.get("META_PRODUCT_SET_ID", "")).strip()
                if not re.fullmatch(r"\d{4,30}", product_set_id):
                    return {**self.health(), "processed": 0, "reason": "ACTIVE_ADSET_PRODUCT_SET_NOT_READ"}
                if configured_set and configured_set != product_set_id:
                    return {**self.health(), "processed": 0, "reason": "CONFIGURED_PRODUCT_SET_DIFFERS_FROM_ACTIVE_ADSET"}
                catalog_resp = await client.get(
                    f"{base}/{product_set_id}", headers=headers,
                    params={"fields": "id,product_catalog{id}"},
                )
                catalog_resp.raise_for_status()
                catalog_data = catalog_resp.json()
                catalog_value = catalog_data.get("product_catalog") or {}
                catalog_id = str(catalog_value.get("id") if isinstance(catalog_value, dict)
                                 else catalog_value or "").strip()
                if not re.fullmatch(r"\d{4,30}", catalog_id):
                    return {**self.health(), "processed": 0, "reason": "ACTIVE_ADSET_CATALOG_NOT_READ"}
            except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
                return {**self.health(), "processed": 0, "reason": "META_PREFLIGHT_" + type(exc).__name__}

            shared_ad = next(
                ((str(r[4]), str(r[5])) for _, _, r in eligible
                 if r[2] in {"ACTIVE", "META_REVIEW_PENDING"} and r[4] and r[5]),
                (None, None),
            )
            for media, product, row in eligible:
                job, variant = media["job_id"], str(media["shopify_variant_id"])
                state, video_id, creative_id, ad_id, last_error = row[2], row[3], row[4], row[5], row[6]
                variant_key = variant.rsplit("/", 1)[-1]
                if variant_key != str(product.get("id", "")).rsplit("/", 1)[-1]:
                    self._save(job, variant, "BLOCKED_MAPPING", video_id, creative_id, ad_id, "EXACT_SHOPIFY_VARIANT_MISMATCH")
                    outcomes.append({"state": "BLOCKED_MAPPING", "reason": "EXACT_SHOPIFY_VARIANT_MISMATCH"})
                    continue
                retryable_error = str(last_error or "").startswith(
                    ("META_HTTP_", "META_CATALOG_VIDEO_")
                )
                if state == "FAILED" and not (
                    video_id and (last_error == "HTTPStatusError" or retryable_error)
                ):
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
                    if not ad_id:
                        saved_creative_id = str(creative_id or "")
                        if not re.fullmatch(r"\d{4,30}", saved_creative_id):
                            saved_creative_id = ""
                        batch_marker = str(creative_id or "")
                        batch_handle = batch_marker.removeprefix("CATALOG_BATCH:")
                        if batch_handle.startswith("{"):
                            parsed_handle = re.search(r"""['"](?:handle|id)['"]\s*:\s*['"]([^'"]+)['"]""", batch_handle)
                            batch_handle = parsed_handle.group(1) if parsed_handle else ""
                        if not batch_handle:
                            stage = "catalog_video_attach"
                            source_url = str(media.get("url") or "")
                            parsed_video = urlsplit(source_url)
                            if (parsed_video.scheme != "https" or parsed_video.hostname != VIDEO_HOST
                                    or parsed_video.query or parsed_video.fragment):
                                raise ValueError("APPROVED_CATALOG_VIDEO_URL_REQUIRED")
                            batch_response = await client.post(
                                f"{base}/{catalog_id}/items_batch", headers=headers,
                                data={
                                    "item_type": "PRODUCT_ITEM",
                                    "allow_upsert": "false",
                                    "requests": json.dumps([{
                                        "method": "UPDATE",
                                        "data": {
                                            "id": variant_key,
                                            "video": [{"url": source_url}],
                                        },
                                    }]),
                                },
                            )
                            batch_response.raise_for_status()
                            batch_payload = batch_response.json()
                            handles = batch_payload.get("handles") or []
                            handle_value = handles[0] if handles else ""
                            if isinstance(handle_value, dict):
                                batch_handle = str(handle_value.get("handle") or handle_value.get("id") or "")
                            else:
                                batch_handle = str(handle_value or "")
                            if not batch_handle:
                                raise ValueError("META_CATALOG_VIDEO_BATCH_HANDLE_MISSING")
                            creative_id = "CATALOG_BATCH:" + batch_handle
                            self._save(job, variant, "META_VIDEO_PROCESSING", video_id,
                                       creative_id, ad_id, None)
                        stage = "catalog_video_status"
                        catalog_ready = False
                        for attempt in range(8):
                            batch_status_response = await client.get(
                                f"{base}/{catalog_id}/check_batch_request_status",
                                headers=headers, params={"handle": batch_handle},
                            )
                            batch_status_response.raise_for_status()
                            batch_status_payload = batch_status_response.json()
                            batch_rows = batch_status_payload.get("data") or []
                            batch_row = batch_rows[0] if batch_rows and isinstance(batch_rows[0], dict) else {}
                            batch_state = str(batch_row.get("status") or batch_status_payload.get("status") or "").lower()
                            batch_errors = batch_row.get("errors") or batch_status_payload.get("errors") or []
                            if batch_errors or batch_state in {"failed", "error", "failure"}:
                                raise ValueError("META_CATALOG_VIDEO_BATCH_REJECTED")
                            if batch_state in {"finished", "complete", "completed", "success", "successful"}:
                                catalog_ready = True
                                break
                            await asyncio.sleep(2)
                        if not catalog_ready:
                            self._save(job, variant, "META_VIDEO_PROCESSING", video_id,
                                       "CATALOG_BATCH:" + batch_handle, ad_id, None)
                            outcomes.append({"state": "META_VIDEO_PROCESSING",
                                             "reason": "CATALOG_PRODUCT_VIDEO_INGEST_PENDING"})
                            continue
                        if shared_ad[0] and shared_ad[1]:
                            creative_id, ad_id = shared_ad
                        else:
                            creative_id = saved_creative_id
                            if not creative_id:
                                story_spec = {
                                    "page_id": page,
                                    "template_data": {
                                        "call_to_action": {"type": "SHOP_NOW"},
                                        "link": str(product["link"]),
                                        "message": "Entdecke ausgewählte Produkte bei Homestro.",
                                        "name": "{{product.name}}",
                                        "description": "{{product.description}}",
                                    },
                                }
                                stage = "catalog_dynamic_creative_create"
                                creative_response = await client.post(
                                    f"{base}/act_{account}/adcreatives", headers=headers,
                                    data={
                                        "name": "Homestro Dynamic Catalog Video",
                                        "object_story_spec": json.dumps(story_spec),
                                        "product_set_id": product_set_id,
                                    },
                                )
                                creative_response.raise_for_status()
                                creative_id = str(creative_response.json().get("id") or "")
                                if not re.fullmatch(r"\d{4,30}", creative_id):
                                    raise ValueError("META_CATALOG_CREATIVE_ID_MISSING")
                            stage = "catalog_dynamic_ad_create"
                            ad_response = await client.post(
                                f"{base}/act_{account}/ads", headers=headers,
                                data={
                                    "name": "Homestro Dynamic Catalog Video",
                                    "adset_id": adset_id,
                                    "creative": json.dumps({"creative_id": creative_id}),
                                    "status": "ACTIVE",
                                },
                            )
                            ad_response.raise_for_status()
                            ad_id = str(ad_response.json().get("id") or "")
                            if not re.fullmatch(r"\d{4,30}", ad_id):
                                raise ValueError("META_CATALOG_AD_ID_MISSING")
                            shared_ad = (creative_id, ad_id)
                    stage = "ad_readback"
                    readback = await client.get(f"{base}/{ad_id}", headers=headers,
                                                params={"fields": "id,status,effective_status,creative{id}"})
                    readback.raise_for_status()
                    remote = readback.json()
                    creative_ref = remote.get("creative") or {}
                    if re.fullmatch(r"\d{4,30}", str(creative_ref.get("id", ""))):
                        creative_id = str(creative_ref["id"])
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
                    if stage == "catalog_video_status" and meta_subcode == 1798040:
                        creative_id = ""
                    self._save(job, variant, "FAILED", video_id, creative_id, ad_id, safe)
                    outcomes.append({"state": "FAILED", "reason": "META_API_REJECTED",
                                     "http_status": exc.response.status_code,
                                     "meta_error_code": meta_code, "meta_error_subcode": meta_subcode, "stage": stage,
                                     "meta_user_title": meta_user_title, "meta_user_message": meta_user_msg})
                except (httpx.HTTPError, OSError, ValueError, TypeError) as exc:
                    safe_error = str(exc)[:120] if isinstance(exc, ValueError) else type(exc).__name__
                    self._save(job, variant, "FAILED", video_id, creative_id, ad_id, safe_error)
                    outcomes.append({"state": "FAILED", "reason": safe_error})
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
