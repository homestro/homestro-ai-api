"""Periodic, fail-closed synchronization of the owned Meta campaign to the Shopify catalog."""
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
from .first_purchase import FirstPurchaseStore
from .media_buyer import MetaPublisher, MetaSaaSPublisher
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
    """Periodically bind the exact existing paused campaign to Meta's All products set.

    Shopify feed records are counted for diagnostics, never reduced to one product.
    The publisher changes the existing ad creative in place and keeps delivery paused
    until the separate spend/readiness controller confirms its remaining gates.
    """
    env = os.environ
    log.info("meta_catalog_worker %s", json.dumps({
        "status": "STARTED", "campaign_id": env.get("PILOT_FIRST_PURCHASE_CAMPAIGN_ID"),
        "writes_performed": False, "activation_performed": False,
    }, separators=(",", ":")))

    while not stop_event.is_set():
        retry_seconds = 3600
        try:
            required = {
                "META_ACCESS_TOKEN": env.get("META_ACCESS_TOKEN", "").strip(),
                "META_AD_ACCOUNT_ID": env.get("META_AD_ACCOUNT_ID", "").strip(),
                "META_PAGE_ID": env.get("META_PAGE_ID", "").strip(),
                "HOMESTRO_PRODUCT_FEED_URL": env.get("HOMESTRO_PRODUCT_FEED_URL", "").strip(),
                "PILOT_FIRST_PURCHASE_CAMPAIGN_ID": env.get("PILOT_FIRST_PURCHASE_CAMPAIGN_ID", "").strip(),
            }
            missing = [key for key, value in required.items() if not value]
            if missing:
                result = {
                    "status": "BLOCKED", "reason": "CONFIG_MISSING", "missing": missing,
                    "writes_performed": False, "activation_performed": False,
                }
            elif not _feed_url_allowed(required["HOMESTRO_PRODUCT_FEED_URL"]):
                result = {
                    "status": "BLOCKED", "reason": "FEED_URL_NOT_ALLOWED",
                    "feed_host": (urlsplit(required["HOMESTRO_PRODUCT_FEED_URL"]).hostname or "")[:120],
                    "writes_performed": False, "activation_performed": False,
                }
            else:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(30, connect=8), follow_redirects=False
                ) as client:
                    response = await client.get(required["HOMESTRO_PRODUCT_FEED_URL"])
                    response.raise_for_status()
                    report = product_feed.parse(
                        response.content, response.headers.get("content-type")
                    )
                feed_record_count = len(report.products)
                if stop_event.is_set():
                    return
                publisher = MetaPublisher(audit, env=env)
                result = await publisher.publish_existing_catalog_campaign(
                    campaign_id=required["PILOT_FIRST_PURCHASE_CAMPAIGN_ID"],
                    feed_record_count=feed_record_count,
                )
                result["feed_records_read"] = feed_record_count
                if result.get("status") in {"catalog_updated_paused", "catalog_verified"}:
                    retry_seconds = 86400
                elif str(result.get("campaign_id", "")).isdigit():
                    try:
                        backoff = FirstPurchaseStore(audit).provider_backoff(
                            str(result["campaign_id"]), datetime.now(timezone.utc)
                        )
                        if backoff:
                            retry_at = datetime.fromisoformat(
                                str(backoff["retry_after"]).replace("Z", "+00:00")
                            )
                            now_utc = datetime.now(timezone.utc)
                            # Give Meta one minute beyond its stored cooldown before retrying.
                            retry_seconds = max(
                                1, int((retry_at - now_utc).total_seconds()) + 60
                            )
                            result["provider_retry_after"] = retry_at.isoformat()
                            result["retry_source"] = "persisted_meta_rate_limit_backoff"
                            result["next_retry_at"] = (
                                now_utc + timedelta(seconds=retry_seconds)
                            ).isoformat()
                    except Exception:
                        pass
                result["active_confirmed"] = (
                    result.get("campaign_status") == "ACTIVE"
                    and result.get("activation_performed") is True
                )
                result["ownership_binding"] = (
                    "EXACT_EXISTING_CAMPAIGN" if result.get("campaign_id")
                    == required["PILOT_FIRST_PURCHASE_CAMPAIGN_ID"] else "NOT_CONFIRMED"
                )
            result.setdefault("writes_performed", False)
            result.setdefault("activation_performed", False)
            try:
                await audit.record("meta_catalog_worker", result)
            except Exception:
                pass
            log.info(
                "meta_catalog_worker %s",
                json.dumps(result, default=str, separators=(",", ":")),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            parts = str(exc).split(":")
            result = {
                "status": "BLOCKED",
                "reason": parts[0][:80],
                "error_type": type(exc).__name__,
                "writes_performed": False,
                "activation_performed": False,
            }
            if isinstance(exc, httpx.HTTPStatusError):
                result["feed_http_status"] = exc.response.status_code
            try:
                await audit.record("meta_catalog_worker", result)
            except Exception:
                pass
            log.error(
                "meta_catalog_worker %s",
                json.dumps(result, separators=(",", ":")),
            )

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=retry_seconds)
        except TimeoutError:
            continue
        except asyncio.CancelledError:
            raise
