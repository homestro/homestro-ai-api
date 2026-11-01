"""One-shot, fail-closed Meta concept creation for the existing FastAPI service.

Creates exactly one paused concept from a validated Shopify feed. It never activates
campaigns, generates media, or changes the ad account's spend cap.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

from .feed_manager import ProductFeedManager
from .first_purchase import AutopilotFeedController
from .media_buyer import MetaSaaSPublisher
from .order_economics import decode_ref, tracked_url, tracking_ref

log = logging.getLogger("uvicorn.error")


def _feed_url_allowed(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        return (
            parsed.scheme == "https"
            and (
                host in {
                    "homestro.de",
                    "www.homestro.de",
                    "homestro-ai-api-fixed-current-production.up.railway.app",
                }
                or host.endswith(".myshopify.com")
            )
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 443)
            and not parsed.fragment
        )
    except ValueError:
        return False


async def _ensure_signed_tracking(publisher: MetaSaaSPublisher, result: dict[str, Any]) -> dict[str, str]:
    campaign_id = str(result.get("campaign_id", "")).strip()
    ad_id = str(result.get("ad_id", "")).strip()
    adset_id = str(result.get("adset_id", "")).strip()
    creative_id = str(result.get("creative_id", "")).strip()
    if not all(value.isdigit() for value in (campaign_id, ad_id, adset_id, creative_id)):
        raise RuntimeError("SIGNED_ATTRIBUTION_OBJECT_IDS_INVALID")

    secret = os.environ.get("PILOT_ATTRIBUTION_SECRET", "").strip() or os.environ.get("PILOT_ADMIN_KEY", "").strip()
    if not secret:
        raise RuntimeError("SIGNED_ATTRIBUTION_SECRET_MISSING")

    now = datetime.now(timezone.utc)
    adset = await publisher._call("GET", adset_id, params={"fields": "end_time,status"})
    if str(adset.get("status", "")).upper() == "ACTIVE":
        raise RuntimeError("SIGNED_ATTRIBUTION_ADSET_MUST_REMAIN_PAUSED")
    end_raw = str(adset.get("end_time", "")).strip()
    if not end_raw:
        raise RuntimeError("SIGNED_ATTRIBUTION_ADSET_END_TIME_MISSING")
    end_at = datetime.fromisoformat(end_raw.replace("Z", "+00:00"))
    expires_at = min(now + timedelta(days=7), end_at - timedelta(minutes=2))
    if expires_at - now <= timedelta(hours=1):
        raise RuntimeError("SIGNED_ATTRIBUTION_WINDOW_TOO_SHORT")

    creative = await publisher._call("GET", creative_id, params={"fields": "id,object_story_spec"})
    story = creative.get("object_story_spec")
    if not isinstance(story, dict) or not isinstance(story.get("link_data"), dict):
        raise RuntimeError("SIGNED_ATTRIBUTION_CREATIVE_LINK_DATA_MISSING")
    link_data = story["link_data"]
    # Meta rejects redundant image sources in link_data; keep the explicit source URL.
    if link_data.get("picture") and link_data.get("image_hash"):
        link_data.pop("image_hash", None)
    destination = str(link_data.get("link", "")).strip()
    if not destination:
        raise RuntimeError("SIGNED_ATTRIBUTION_DESTINATION_MISSING")

    existing_ref = parse_qs(urlsplit(destination).query).get("pilot_ref", [None])[0]
    decoded = decode_ref(existing_ref, secret=secret, at=now) if existing_ref else None
    if (
        decoded
        and decoded.get("channel") == "meta"
        and decoded.get("campaign") == campaign_id
        and decoded.get("ad") == ad_id
        and datetime.fromisoformat(str(decoded.get("expires", "")).replace("Z", "+00:00")) >= expires_at
    ):
        return {"status": "ALREADY_ATTACHED", "creative_id": creative_id}

    experiment = hashlib.sha256(f"{campaign_id}:{ad_id}:homestro-purchase".encode()).hexdigest()[:24]
    ref = tracking_ref(
        campaign_id,
        ad_id,
        experiment,
        secret=secret,
        issued_at=now,
        expires_at=expires_at,
        channel="meta",
    )
    link_data["link"] = tracked_url(destination, ref, secret=secret, at=now)

    publisher.write_attempted = True
    await publisher._call(
        "POST",
        ad_id,
        data={
            "creative": json.dumps({"object_story_spec": story}, ensure_ascii=False),
            "status": "PAUSED",
        },
    )
    ad_readback = await publisher._call(
        "GET", ad_id, params={"fields": "id,status,effective_status,creative{id}"}
    )
    new_creative_id = str((ad_readback.get("creative") or {}).get("id", "")).strip()
    if (
        str(ad_readback.get("id", "")) != ad_id
        or str(ad_readback.get("status", "")).upper() != "PAUSED"
        or not new_creative_id.isdigit()
    ):
        raise RuntimeError("SIGNED_ATTRIBUTION_AD_UPDATE_READBACK_FAILED")
    creative_readback = await publisher._call(
        "GET", new_creative_id, params={"fields": "id,object_story_spec"}
    )
    readback_story = creative_readback.get("object_story_spec") or {}
    readback_data = readback_story.get("link_data") or {}
    readback_url = str(readback_data.get("link", ""))
    readback_ref = parse_qs(urlsplit(readback_url).query).get("pilot_ref", [None])[0]
    verified = decode_ref(readback_ref, secret=secret, at=now) if readback_ref else None
    if (
        str(creative_readback.get("id", "")) != new_creative_id
        or not verified
        or verified.get("campaign") != campaign_id
        or verified.get("ad") != ad_id
        or verified.get("channel") != "meta"
    ):
        raise RuntimeError("SIGNED_ATTRIBUTION_READBACK_FAILED")
    return {"status": "ATTACHED", "creative_id": new_creative_id, "expires_at": expires_at.isoformat()}


async def autonomous_draft_worker(
    product_feed: ProductFeedManager,
    audit: Any,
    stop_event: asyncio.Event,
) -> None:
    """Create one approved-scope concept after boot; all Meta objects stay PAUSED."""
    publisher = None
    log.info("meta_paused_concept_worker %s", json.dumps({
        "status": "STARTED",
        "writes_performed": False,
    }, separators=(",", ":")))
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=5)
        log.warning("meta_paused_concept_worker %s", json.dumps({
            "status": "STOPPED_BEFORE_RUN",
            "reason": "APPLICATION_SHUTDOWN",
            "writes_performed": False,
        }, separators=(",", ":")))
        return
    except TimeoutError:
        pass
    except asyncio.CancelledError:
        log.warning("meta_paused_concept_worker %s", json.dumps({
            "status": "CANCELLED_BEFORE_RUN",
            "writes_performed": False,
        }, separators=(",", ":")))
        raise

    env = os.environ
    log.info("meta_paused_concept_worker %s", json.dumps({
        "status": "READING_PRODUCT_FEED",
        "writes_performed": False,
    }, separators=(",", ":")))
    required = {
        "META_ACCESS_TOKEN": env.get("META_ACCESS_TOKEN", "").strip(),
        "META_AD_ACCOUNT_ID": env.get("META_AD_ACCOUNT_ID", "").strip(),
        "META_PAGE_ID": env.get("META_PAGE_ID", "").strip(),
        "HOMESTRO_PRODUCT_FEED_URL": env.get("HOMESTRO_PRODUCT_FEED_URL", "").strip(),
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        log.warning("meta_paused_concept %s", json.dumps({
            "status": "BLOCKED", "reason": "CONFIG_MISSING", "missing": missing,
            "writes_performed": False,
        }))
        return
    if not _feed_url_allowed(required["HOMESTRO_PRODUCT_FEED_URL"]):
        log.warning("meta_paused_concept %s", json.dumps({
            "status": "BLOCKED", "reason": "FEED_URL_NOT_ALLOWED",
            "feed_host": (urlsplit(required["HOMESTRO_PRODUCT_FEED_URL"]).hostname or "")[:120],
            "writes_performed": False,
        }))
        return
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        ) as client:
            response = await client.get(required["HOMESTRO_PRODUCT_FEED_URL"])
            response.raise_for_status()
            report = product_feed.parse(response.content, response.headers.get("content-type"))
        products = [
            row.model_dump(mode="json")
            for row in report.products
        ]
        filtered = AutopilotFeedController().process_and_filter_feed(products)
        if not filtered:
            log.warning("meta_paused_concept %s", json.dumps({
                "status": "BLOCKED", "reason": "NO_ELIGIBLE_SHOPIFY_PRODUCTS",
                "feed_records": len(report.products), "writes_performed": False,
            }))
            return
        if stop_event.is_set():
            return
        publisher = MetaSaaSPublisher(
            required["META_ACCESS_TOKEN"],
            required["META_AD_ACCOUNT_ID"],
            MetaSaaSPublisher.EXPECTED_PIXEL_ID,
            required["META_PAGE_ID"],
            api_version=(
                env.get("META_API_VERSION", "").strip()
                or env.get("META_GRAPH_VERSION", "").strip()
                or "v26.0"
            ),
        )
        result = await publisher.deploy_paused_concept(filtered[0], initial_budget_eur=5.0)
        if result.get("status") in {"CONCEPT_CREATED", "CONCEPT_RECONCILED"}:
            tracking = await _ensure_signed_tracking(publisher, result)
            result["creative_id"] = tracking["creative_id"]
            result["signed_attribution"] = {
                "status": tracking["status"],
                "expires_at": tracking.get("expires_at"),
            }
        result["ownership_binding"] = "NOT_APPLICABLE"
        campaign_id = str(result.get("campaign_id", "")).strip()
        product_id = str(filtered[0].get("id", "")).strip()
        if (
            result.get("status") in {"CONCEPT_CREATED", "CONCEPT_RECONCILED"}
            and campaign_id.isdigit()
            and product_id
        ):
            account_id = required["META_AD_ACCOUNT_ID"]
            account_id = account_id if account_id.startswith("act_") else f"act_{account_id}"
            claim = await audit.get_meta_micro_campaign_claim()
            if claim is None:
                if await audit.claim_meta_micro_campaign(account_id, product_id):
                    await audit.update_meta_micro_campaign(
                        status="RECONCILED_EXISTING_CAMPAIGN",
                        campaign_id=campaign_id,
                    )
                    claim = await audit.get_meta_micro_campaign_claim()
            if claim and claim.get("campaign_id") == campaign_id:
                if claim.get("status") == "CLAIMED":
                    await audit.update_meta_micro_campaign(
                        status="RECONCILED_EXISTING_CAMPAIGN",
                        campaign_id=campaign_id,
                    )
                result["ownership_binding"] = "BOUND_TO_EXACT_PAUSED_CAMPAIGN"
            elif claim:
                result["ownership_binding"] = "BLOCKED_EXISTING_CAMPAIGN_CLAIM"
                result["existing_claim_campaign_id"] = claim.get("campaign_id")
                result["existing_claim_status"] = claim.get("status")
            else:
                result["ownership_binding"] = "BLOCKED_CLAIM_RACE"
        result["writes_performed"] = result.get("status") in {"CONCEPT_CREATED", "CONCEPT_RECONCILED"} or result.get("writes_performed") is True
        result["feed_records"] = len(report.products)
        result["filtered_candidates"] = len(filtered)
        await audit.record("meta_paused_concept", result)
        log.info("meta_paused_concept %s", json.dumps(result, default=str, separators=(",", ":")))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Do not log provider bodies, URLs with queries, request headers, or tokens.
        parts = str(exc).split(":")
        code = parts[0][:80]
        payload = {
            "status": "BLOCKED",
            "reason": code,
            "error_type": type(exc).__name__,
            "writes_performed": "unknown" if publisher is not None and publisher.write_attempted else False,
        }
        if code == "META_API_ERROR" and len(parts) >= 5:
            for key, raw in (
                ("meta_http_status", parts[1]),
                ("meta_error_code", parts[2]),
                ("meta_error_subcode", parts[3]),
            ):
                if raw.isdigit():
                    payload[key] = int(raw)
            payload["meta_stage"] = parts[4][:40]
        provider_details = getattr(exc, "meta_details", {})
        if isinstance(provider_details, dict):
            for key in (
                "meta_error_type",
                "meta_error_title",
                "meta_error_message",
                "meta_error_summary",
                "meta_fbtrace_id",
                "meta_target_account_visible",
                "meta_accessible_ad_account_ids",
                "meta_account_list_complete",
                "meta_accessible_accounts_probe",
                "meta_target_page_visible",
                "meta_accessible_page_ids",
                "meta_accessible_pages",
                "meta_page_list_complete",
                "meta_accessible_pages_probe",
            ):
                value = provider_details.get(key)
                if isinstance(value, str):
                    payload[key] = " ".join(value.split())[:240]
        try:
            await audit.record("meta_paused_concept", payload)
        except Exception:
            pass
        log.error("meta_paused_concept %s", json.dumps(payload, separators=(",", ":")))
