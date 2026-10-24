"""Crash-tolerant async scheduler for read-only and dry-run Pilot cycles."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from .feed_manager import ProductFeedManager
from .github_reporter import GitHubPRReporter
from .gmc_diagnostics import MerchantDiagnosticsClient
from .media_buyer import MetaAdLibraryClient, MetaPublisher, PlanAuditStore
from .micro_budget import (
    MetaAccountReadiness,
    MicroBudgetGate,
    configured_daily_budget_limit_eur,
    live_ads_dry_run,
)

logger = logging.getLogger("uvicorn.error")
Job = Callable[[], Awaitable[dict[str, Any]]]


def _openai_error_metadata(exc: httpx.HTTPStatusError) -> dict[str, Any]:
    """Return a safe, bounded summary of an OpenAI HTTP error (never its body)."""
    path = exc.request.url.path
    model = (
        os.getenv("PILOT_IMAGE_MODEL", "gpt-image-1")
        if path.startswith("/v1/images/")
        else os.getenv("PILOT_LLM_MODEL", "gpt-4.1-mini")
    )
    try:
        payload = exc.response.json()
    except (ValueError, json.JSONDecodeError):
        payload = {}
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    if not isinstance(error, dict):
        error = {}

    def safe_label(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        label = "".join(
            char for char in value
            if char.isascii() and (char.isalnum() or char in "._-")
        )[:80]
        return label or None

    return {
        "api_endpoint": path[:100],
        "model": safe_label(model),
        "provider_error_type": safe_label(error.get("type")),
        "provider_error_code": safe_label(error.get("code")),
    }


class PilotDaemon:
    """Runs each job independently; a failed provider cannot terminate the scheduler."""

    def __init__(
        self,
        audit: PlanAuditStore,
        *,
        feed_interval_hours: int = 6,
        competitor_interval_hours: int = 24,
        metrics_interval_hours: int = 12,
        heartbeat_interval_seconds: int = 3600,
        reporter: GitHubPRReporter | None = None,
        feed_job: Job | None = None,
        merchant_job: Job | None = None,
        competitor_job: Job | None = None,
        creative_job: Job | None = None,
        metrics_job: Job | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        random_uniform: Callable[[float, float], float] = random.uniform,
    ):
        if (
            min(feed_interval_hours, competitor_interval_hours, metrics_interval_hours)
            < 1
        ):
            raise ValueError("job intervals must be positive")
        if heartbeat_interval_seconds < 1:
            raise ValueError("heartbeat interval must be positive")
        self.audit = audit
        self.reporter = reporter
        self.heartbeat_interval_seconds = heartbeat_interval_seconds
        self.sleep = sleep
        self.random_uniform = random_uniform
        self.jobs: dict[str, tuple[float, Job]] = {
            "feed_diagnostics": (
                feed_interval_hours * 3600,
                feed_job or self._feed_job,
            ),
            "merchant_center_diagnostics": (
                feed_interval_hours * 3600,
                merchant_job or self._merchant_diagnostics_job,
            ),
            "competitor_scan": (
                competitor_interval_hours * 3600,
                competitor_job or self._competitor_job,
            ),
            "creative_candidates": (
                competitor_interval_hours * 3600,
                creative_job or self._creative_job,
            ),
            "media_buying_plan": (
                metrics_interval_hours * 3600,
                metrics_job or self._metrics_job,
            ),
        }
        self._next_run = {name: 0.0 for name in self.jobs}
        self._retry_at = {name: 0.0 for name in self.jobs}
        self._failures = {name: 0 for name in self.jobs}
        self._last_results: dict[str, dict[str, Any]] = {}
        self._latest_products: list[dict[str, Any]] = []

    async def run(self, stop: asyncio.Event) -> None:
        """Runs immediately, then emits hourly heartbeats until shutdown."""
        while not stop.is_set():
            cycle_started = datetime.now(UTC).isoformat()
            for name, (interval, job) in self.jobs.items():
                now = time.monotonic()
                if self._failures[name] > 0:
                    if now < self._retry_at[name]:
                        continue
                elif now < self._next_run[name]:
                    continue
                try:
                    result = await asyncio.wait_for(job(), timeout=300)
                    self._failures[name] = 0
                    self._retry_at[name] = 0
                    self._next_run[name] = time.monotonic() + interval
                    self._last_results[name] = {"status": "completed", **result}
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - module-level recovery boundary
                    self._failures[name] += 1
                    base_delay = min(
                        3600.0, 30.0 * (2 ** min(self._failures[name] - 1, 7))
                    )
                    delay = min(3600.0, base_delay * self.random_uniform(0.8, 1.2))
                    self._retry_at[name] = time.monotonic() + delay
                    self._last_results[name] = {
                        "status": "retry_scheduled",
                        "error_type": type(exc).__name__,
                        "retry_seconds": round(delay),
                        "attempt": self._failures[name],
                    }
                    logger.error(
                        "pilot_job_failed job=%s error_type=%s retry_seconds=%.0f",
                        name,
                        type(exc).__name__,
                        delay,
                    )

            daily_budget_limit = configured_daily_budget_limit_eur()
            report = {
                "generated_at": datetime.now(UTC).isoformat(),
                "cycle_started_at": cycle_started,
                "dry_run": live_ads_dry_run(),
                "budget_limit_eur": daily_budget_limit,
                "budget_type": "daily",
                "scheduled_window_days": MicroBudgetGate.PLANNED_DAYS,
                "planned_total_budget_eur": round(
                    daily_budget_limit * MicroBudgetGate.PLANNED_DAYS, 2
                ),
                "micro_budget_submission_enabled": (
                    os.getenv("ALLOW_MICRO_BUDGET", "false").strip().lower() == "true"
                    and not live_ads_dry_run()
                    and daily_budget_limit >= MicroBudgetGate.DAILY_BUDGET_EUR
                ),
                "optimizer": {
                    "dry_run": True,
                    "budget_limit_eur": 0.0,
                    "execution": "READ_ONLY",
                },
                "jobs": self._last_results,
            }
            try:
                await self.audit.record("daemon_heartbeat", report)
                logger.info(
                    "pilot_heartbeat %s",
                    json.dumps(report, ensure_ascii=False, separators=(",", ":")),
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("pilot_heartbeat_persist_failed")
            if self.reporter:
                try:
                    report["github_report"] = await self.reporter.publish(report)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # GitHub reporting failure does not affect feed/creative/metrics jobs.
                    logger.exception("pilot_github_report_failed")
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=self.heartbeat_interval_seconds
                )
            except TimeoutError:
                continue

    async def _feed_job(self) -> dict[str, Any]:
        feed_url = os.getenv("HOMESTRO_PRODUCT_FEED_URL", "").strip()
        if not feed_url:
            return {"status": "blocked", "reason": "PRODUCT_FEED_URL_NOT_CONFIGURED"}
        parsed = urlsplit(feed_url)
        allowed_feed_hosts = {
            "homestro.de",
            "www.homestro.de",
            "homestro-ai-api-fixed-current-production.up.railway.app",
        }
        if (
            parsed.scheme != "https"
            or parsed.hostname not in allowed_feed_hosts
            or parsed.username
            or parsed.password
            or parsed.port not in {None, 443}
        ):
            return {"status": "blocked", "reason": "FEED_URL_HOST_NOT_ALLOWED"}
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        ) as client:
            response = await client.get(
                feed_url, headers={"Accept": "application/xml, application/json"}
            )
            response.raise_for_status()
            if len(response.content) > 12 * 1024 * 1024:
                return {"status": "blocked", "reason": "FEED_SIZE_LIMIT_EXCEEDED"}
            report = ProductFeedManager().parse(
                response.content, response.headers.get("content-type")
            )
        self._latest_products = [
            product.model_dump(mode="json") for product in report.products
        ]
        await self.audit.record(
            "daemon_feed_diagnostics", report.model_dump(mode="json")
        )
        return {
            "status": "diagnosed",
            "source_format": report.source_format,
            "products_checked": len(report.products),
            "rejected_rows": report.rejected_rows,
            "errors": sum(i.severity == "error" for i in report.issues),
            "warnings": sum(i.severity == "warning" for i in report.issues),
            "merchant_write": "not_configured_and_never_attempted",
        }

    async def _competitor_job(self) -> dict[str, Any]:
        token = os.getenv("META_AD_LIBRARY_ACCESS_TOKEN", "").strip()
        if not token:
            return {
                "status": "partial",
                "meta": "blocked_access_token_missing",
                "tiktok": "not_available_no_authorized_api_configured",
            }
        client = MetaAdLibraryClient(
            token, api_version=os.getenv("META_GRAPH_VERSION", "v26.0")
        )
        ads = await client.search(
            ["Hundezubehör", "Haushalt", "Fitness Rucksack"], country="DE", limit=20
        )
        await self.audit.record(
            "daemon_competitor_scan",
            {
                "source": "official_meta_ad_library",
                "ads": [ad.model_dump(mode="json") for ad in ads],
                "limitation": "public_examples_only; no competitor ROAS, conversions or profit",
            },
        )
        return {
            "status": "completed",
            "source": "official_meta_ad_library",
            "public_ad_examples": len(ads),
            "tiktok": "not_available_no_authorized_api_configured",
        }

    async def _merchant_diagnostics_job(self) -> dict[str, Any]:
        merchant_id = os.getenv("GMC_MERCHANT_ID", "").strip()
        credentials = os.getenv("GMC_SERVICE_ACCOUNT_JSON", "").strip()
        if not merchant_id or not credentials:
            return {
                "status": "blocked",
                "reason": "GMC_MERCHANT_ID_OR_SERVICE_ACCOUNT_NOT_CONFIGURED",
                "mutations_performed": False,
            }
        client = MerchantDiagnosticsClient(merchant_id, credentials_json=credentials)
        report = await client.diagnose()
        await self.audit.record("merchant_center_diagnostics", report)
        return report

    async def _creative_job(self) -> dict[str, Any]:
        """Submit the catalog-based pilot without paid AI creative generation.

        Meta's catalog creative uses approved item images and destinations from the
        connected product set, so this path must not depend on an OpenAI image,
        logo URL, or a one-product creative candidate.
        """
        reconciliation = await MetaPublisher(self.audit).reconcile_retired_campaign()
        await self.audit.record("retired_campaign_reconciliation", reconciliation)
        candidates = [
            product
            for product in self._latest_products
            if str(product.get("id", "")).strip()
            and str(product.get("link", "")).strip()
        ]
        if not candidates:
            return {"status": "blocked", "reason": "NO_VALIDATED_CATALOG_PRODUCTS"}
        product_ids = {str(p.get("id")) for p in self._latest_products}
        product = candidates[0]
        publisher_result = await MetaPublisher(self.audit).publish_one(
            creative=None,
            product=product,
            product_ids_in_feed=product_ids,
        )
        await self.audit.record(
            "daemon_catalog_campaign_attempt",
            {
                "product_scope": "configured_meta_product_set",
                "validated_product_count": len(product_ids),
                "publisher": publisher_result,
            },
        )
        return {
            "status": publisher_result.get("status", "blocked"),
            "retired_campaign": reconciliation,
            "product_scope": "configured_meta_product_set",
            "validated_product_count": len(product_ids),
            "publisher": publisher_result,
        }

    @staticmethod
    async def _fetch_brand_image(url: str) -> bytes:
        parsed = urlsplit(url)
        allowed_hosts = {"homestro.de", "www.homestro.de", "cdn.shopify.com"}
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.hostname not in allowed_hosts
        ):
            raise ValueError("image host is not an approved Homestro or Shopify host")
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        ) as client:
            response = await client.get(
                url, headers={"Accept": "image/png,image/jpeg,image/webp"}
            )
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if content_type not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("source asset is not a supported image")
            if len(response.content) > 6_000_000:
                raise ValueError("source image exceeds the size limit")
            return response.content

    async def _metrics_job(self) -> dict[str, Any]:
        meta_preflight = await MetaPublisher(self.audit).check_readiness()
        account = (
            MetaAccountReadiness.model_validate(meta_preflight["account"])
            if meta_preflight.get("status") == "checked"
            else None
        )
        micro_budget = MicroBudgetGate().evaluate(
            account=account,
            product_ids_in_feed={str(p.get("id")) for p in self._latest_products},
            purchase_event_verified=(
                os.getenv("META_PURCHASE_EVENT_VERIFIED", "false").strip().lower()
                == "true"
            ),
            # This optimization pass is intentionally read-only and cannot publish.
            dry_run=True,
        )
        daily_budget_limit = configured_daily_budget_limit_eur()
        return {
            "status": "blocked",
            "reason": "NO_VERIFIED_CHANNEL_METRICS_LOADER",
            "execution": "READ_ONLY_PREFLIGHT_ONLY",
            "optimizer_dry_run": True,
            "optimizer_budget_limit_eur": 0.0,
            "campaign_submission_config": {
                "dry_run": live_ads_dry_run(),
                "daily_budget_limit_eur": daily_budget_limit,
                "daily_budget_eur": MicroBudgetGate.DAILY_BUDGET_EUR,
                "scheduled_window_days": MicroBudgetGate.PLANNED_DAYS,
                "planned_total_budget_eur": round(
                    MicroBudgetGate.DAILY_BUDGET_EUR
                    * MicroBudgetGate.PLANNED_DAYS,
                    2,
                ),
                "enabled_by_config": (
                    os.getenv("ALLOW_MICRO_BUDGET", "false").strip().lower() == "true"
                    and not live_ads_dry_run()
                    and daily_budget_limit >= MicroBudgetGate.DAILY_BUDGET_EUR
                ),
            },
            "meta_ads_preflight": meta_preflight,
            "optimizer_micro_budget_preflight": micro_budget.model_dump(mode="json"),
            "micro_budget_execution": (
                "READ_ONLY_PREFLIGHT_ONLY"
                if meta_preflight.get("status") == "checked"
                else "BLOCKED_META_PREFLIGHT"
            ),
        }

