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
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from .creative_factory import BrandKit, CreativeFactory, OpenAIProvider
from .feed_manager import ProductFeedManager
from .github_reporter import GitHubPRReporter
from .gmc_diagnostics import MerchantDiagnosticsClient
from .media_buyer import MetaAdLibraryClient, MetaPublisher, PlanAuditStore
from .meta_insights import MetaInsightsClient
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
        if parsed.scheme != "https" or parsed.hostname not in {
            "homestro.de",
            "www.homestro.de",
        }:
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
        if os.getenv("PILOT_CREATIVE_ENABLED", "false").lower() != "true":
            return {"status": "blocked", "reason": "CREATIVE_GENERATION_DISABLED"}
        if not os.getenv("OPENAI_API_KEY"):
            return {"status": "blocked", "reason": "OPENAI_API_KEY_MISSING"}
        logo_url = os.getenv("HOMESTRO_LOGO_URL", "").strip()
        candidates = [
            product
            for product in self._latest_products
            if product.get("description") and product.get("image_link")
        ]
        selected_product_id = os.getenv("MICRO_BUDGET_PRODUCT_ID", "").strip()
        if selected_product_id:
            candidates = [p for p in candidates if str(p.get("id")) == selected_product_id]
        if not candidates or not logo_url:
            return {"status": "blocked", "reason": "VERIFIED_PRODUCT_IMAGE_OR_LOGO_MISSING"}
        product = candidates[0]
        stage = "product_image_download"
        try:
            product_image = await self._fetch_brand_image(product["image_link"])
            stage = "logo_download"
            logo_image = await self._fetch_brand_image(logo_url)
        except httpx.HTTPStatusError as exc:
            return {
                "status": "blocked",
                "reason": "CREATIVE_ASSET_HTTP_ERROR",
                "stage": stage,
                "http_status": exc.response.status_code,
                "host": exc.request.url.host,
            }
        product["facts"] = [
            value.strip()
            for value in product["description"].split(".")
            if value.strip()
        ][:10]
        if not product["facts"]:
            return {"status": "blocked", "reason": "VERIFIED_PRODUCT_FACTS_MISSING"}
        provider = OpenAIProvider(
            os.environ["OPENAI_API_KEY"],
            text_model=os.getenv("PILOT_LLM_MODEL", "gpt-4.1-mini"),
            image_model=os.getenv("PILOT_IMAGE_MODEL", "gpt-image-1"),
        )
        factory = CreativeFactory(
            llm=provider,
            image_editor=provider,
            brand=BrandKit(
                primary_hex=os.getenv("HOMESTRO_BRAND_PRIMARY", "#246B4B"),
                secondary_hex=os.getenv("HOMESTRO_BRAND_SECONDARY", "#F2EFE7"),
                accent_hex=os.getenv("HOMESTRO_BRAND_ACCENT", "#D8A83E"),
            ),
            output_dir=Path(os.getenv("PILOT_CREATIVE_DIR", "/data/adtech-creatives")),
            minimum_score=int(os.getenv("PILOT_CREATIVE_MIN_SCORE", "85")),
        )
        stage = "openai_copy_and_image_generation"
        try:
            candidate = await factory.create(
                product=product,
                platform="meta",
                product_image=product_image,
                logo_image=logo_image,
            )
        except httpx.HTTPStatusError as exc:
            return {
                "status": "blocked",
                "reason": "CREATIVE_PROVIDER_HTTP_ERROR",
                "stage": stage,
                "http_status": exc.response.status_code,
                "host": exc.request.url.host,
                **_openai_error_metadata(exc),
            }
        except ValidationError as exc:
            invalid_fields = [
                {
                    "field": ".".join(str(part) for part in item.get("loc", ()))[:100],
                    "error": str(item.get("type", "validation_error"))[:80],
                }
                for item in exc.errors(
                    include_input=False, include_context=False, include_url=False
                )[:10]
            ]
            return {
                "status": "blocked",
                "reason": "CREATIVE_OUTPUT_VALIDATION_FAILED",
                "invalid_fields": invalid_fields,
            }
        await self.audit.record("daemon_creative_candidate", candidate)
        publisher_result = {"status": "not_submitted"}
        if candidate.publishable_candidate:
            publisher_result = await MetaPublisher(self.audit).publish_one(
                creative=candidate,
                product=product,
                product_ids_in_feed={str(p.get("id")) for p in self._latest_products},
            )
        return {
            "status": "candidate_ready" if candidate.publishable_candidate else "rejected_and_deleted",
            "product_id": product["id"],
            "quality_score": candidate.score.quality_score,
            "asset_path": candidate.asset_path or None,
            "published": publisher_result.get("status") == "ACTIVE_PENDING_REVIEW",
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
            product_id=os.getenv("MICRO_BUDGET_PRODUCT_ID"),
            product_ids_in_feed={str(p.get("id")) for p in self._latest_products},
            # This optimization pass is intentionally read-only and cannot publish.
            dry_run=True,
        )
        daily_budget_limit = configured_daily_budget_limit_eur()
        response: dict[str, Any] = {
            "execution": "READ_ONLY",
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
                "READ_ONLY_METRICS_ONLY"
                if meta_preflight.get("status") == "checked"
                else "BLOCKED_META_PREFLIGHT"
            ),
        }
        if account is None:
            response.update(
                {
                    "status": "blocked",
                    "reason": "META_ACCOUNT_PREFLIGHT_NOT_VERIFIED",
                    "metrics_source": None,
                }
            )
            return response

        token = os.getenv("META_ACCESS_TOKEN", "").strip()
        if not token:
            response.update(
                {
                    "status": "blocked",
                    "reason": "META_INSIGHTS_ACCESS_TOKEN_MISSING",
                    "metrics_source": None,
                }
            )
            return response

        try:
            metrics = await MetaInsightsClient(
                token,
                account.account_id,
                api_version=os.getenv("META_API_VERSION", "v26.0"),
            ).campaign_metrics(days=7)
        except httpx.HTTPStatusError as exc:
            response.update(
                {
                    "status": "blocked",
                    "reason": "META_INSIGHTS_HTTP_ERROR",
                    "http_status": exc.response.status_code,
                    "metrics_source": "meta_marketing_api_insights",
                }
            )
            return response

        response.update(
            {
                "status": "metrics_loaded" if metrics else "no_campaign_metrics",
                "metrics_source": "meta_marketing_api_insights",
                "window_days": 7,
                "campaigns_checked": len(metrics),
                "totals": {
                    "spend_eur": round(sum(item.spend_eur for item in metrics), 2),
                    "meta_reported_purchases": sum(item.conversions for item in metrics),
                    "meta_reported_purchase_value_eur": round(
                        sum(item.revenue_eur for item in metrics), 2
                    ),
                    "clicks": sum(item.clicks for item in metrics),
                    "impressions": sum(item.impressions for item in metrics),
                },
                "campaign_metrics": [
                    {
                        "campaign_id": item.campaign_id,
                        "campaign_name": item.campaign_name,
                        "spend_eur": item.spend_eur,
                        "meta_reported_purchases": item.conversions,
                        "meta_reported_purchase_value_eur": item.revenue_eur,
                        "clicks": item.clicks,
                        "impressions": item.impressions,
                        "attribution_verified": False,
                    }
                    for item in metrics
                ],
                "optimizer_status": "HOLD",
                "optimizer_reason": "SHOPIFY_ORDERS_AND_CONTRIBUTION_MARGIN_NOT_JOINED",
                "revenue_note": (
                    "Meta-reported purchase values only; not reconciled with Shopify "
                    "orders or product contribution margin."
                ),
            }
        )
        return response

