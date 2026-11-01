"""One-shot, fail-closed Meta concept creation for the existing FastAPI service.

Creates exactly one paused concept from a validated Shopify feed. It never activates
campaigns, generates media, or changes the ad account's spend cap.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any
from urllib.parse import urlsplit

import httpx

from .feed_manager import ProductFeedManager
from .first_purchase import AutopilotFeedController
from .media_buyer import MetaSaaSPublisher

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
