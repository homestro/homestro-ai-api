"""Crash-tolerant async scheduler for read-only and dry-run Pilot cycles."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from .control_cycle import control_plan
from .feed_manager import ProductFeedManager
from .github_reporter import GitHubPRReporter
from .gmc_diagnostics import MerchantDiagnosticsClient
from .media_buyer import MetaAdLibraryClient, MetaPublisher, PlanAuditStore
from .micro_budget import (
    MetaAccountReadiness,
    MicroBudgetGate,
    configured_daily_budget_limit_eur,
    live_ads_dry_run,
    measurement_risk_accepted,
)
from .performance_loader import load_meta_performance, performance_decision

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
        catalog_job: Job | None = None,
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
                300,
                creative_job or self._creative_job,
            ),
            "media_buying_plan": (
                metrics_interval_hours * 3600,
                metrics_job or self._metrics_job,
            ),
            "meta_catalog_access": (
                feed_interval_hours * 3600,
                catalog_job or self._catalog_access_job,
            ),
        }
        self._next_run = {name: 0.0 for name in self.jobs}
        self._retry_at = {name: 0.0 for name in self.jobs}
        self._failures = {name: 0 for name in self.jobs}
        self._last_results: dict[str, dict[str, Any]] = {}
        self._latest_products: list[dict[str, Any]] = []
        self._evidence_times: dict[str, float] = {}

    async def run(self, stop: asyncio.Event) -> None:
        """Runs immediately, then emits hourly heartbeats until shutdown."""
        next_heartbeat = 0.0
        while not stop.is_set():
            cycle_started = datetime.now(UTC).isoformat()
            # Refresh shared metrics before a due creative cycle; provider backoff still wins.
            creative_due = time.monotonic() >= self._next_run["creative_candidates"]
            metrics_age = time.monotonic() - self._evidence_times.get("media_buying_plan", -1e12)
            if creative_due and metrics_age > 900:
                self._next_run["media_buying_plan"] = 0
            order = ("feed_diagnostics", "merchant_center_diagnostics", "competitor_scan",
                     "media_buying_plan", "meta_catalog_access", "creative_candidates")
            for name in order:
                interval, job = self.jobs[name]
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
                    if name == "feed_diagnostics":
                        if result.get("status") == "diagnosed" and result.get("products_checked", 0) > 0:
                            self._evidence_times[name] = time.monotonic()
                    elif name == "media_buying_plan":
                        if (result.get("performance") or {}).get("status") in {"collected", "no_managed_campaign"}:
                            self._evidence_times[name] = time.monotonic()
                    else:
                        self._evidence_times[name] = time.monotonic()
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

            if time.monotonic() < next_heartbeat:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=60)
                except TimeoutError:
                    pass
                continue
            next_heartbeat = time.monotonic() + self.heartbeat_interval_seconds
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
                    stop.wait(), timeout=min(60, self.heartbeat_interval_seconds)
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
        from .order_economics import sync_unit_costs
        from .payment_webhooks import PaymentWebhookStore, payment_database
        from .store_diagnostics import audit_store

        try:
            async with asyncio.timeout(35):
                storefront = await audit_store(self._latest_products)
        except TimeoutError:
            storefront = {"status": "unavailable", "reason": "STOREFRONT_DIAGNOSTIC_TIMEOUT"}
        await self.audit.record("storefront_diagnostics", storefront)
        try:
            async with asyncio.timeout(40):
                unit_costs = await sync_unit_costs(PaymentWebhookStore(payment_database(os.environ)))
        except TimeoutError:
            unit_costs = {"status": "unavailable", "reason": "COST_SYNC_TIMEOUT"}
        from .seo_writer import SEORevisionWriter

        try:
            async with asyncio.timeout(60):
                seo_publication = await SEORevisionWriter(self.audit).cycle(self._latest_products)
        except TimeoutError:
            seo_publication = {"status": "hold", "reason": "SEO_CYCLE_TIMEOUT_PENDING_REVISIONS_RETAINED"}
        await self.audit.record("seo_publication", seo_publication)
        logger.info("seo_publication %s", json.dumps(seo_publication, separators=(",", ":")))
        return {
            "seo_publication": seo_publication,
            "status": "diagnosed", "unit_costs": unit_costs, "storefront": storefront,
            "source_format": report.source_format,
            "products_checked": len(report.products),
            "rejected_rows": report.rejected_rows,
            "errors": sum(i.severity == "error" for i in report.issues),
            "warnings": sum(i.severity == "warning" for i in report.issues),
            "merchant_write": "not_configured_and_never_attempted",
        }

    async def _competitor_job(self) -> dict[str, Any]:
        """Compare public Meta Ad Library examples with the current Shopify feed.

        Longevity is a public-ad signal only. It does not prove that an ad is still
        delivering or profitable. Results prioritize candidates for review and never
        unlock spend or create ads.
        """
        token = (os.getenv("META_AD_LIBRARY_ACCESS_TOKEN") or os.getenv("META_ACCESS_TOKEN") or "").strip()
        if not token:
            return {
                "status": "partial",
                "meta": "blocked_access_token_missing",
                "tiktok": "not_available_no_authorized_api_configured",
                "sell_the_trend": "not_available_no_authorized_api_configured",
                "minea": "not_available_no_authorized_api_configured",
            }
        if not self._latest_products:
            return {
                "status": "blocked",
                "reason": "SHOPIFY_FEED_NOT_LOADED",
                "campaign_writes_performed": False,
            }

        # Use real product categories present in the feed to scope public searches.
        category_counts: dict[str, int] = {}
        for product in self._latest_products:
            category = str(
                product.get("product_type")
                or product.get("google_product_category")
                or ""
            ).strip()
            if category:
                category_counts[category] = category_counts.get(category, 0) + 1
        search_terms = [
            category
            for category, _ in sorted(
                category_counts.items(), key=lambda item: (-item[1], item[0].casefold())
            )[:5]
        ]
        if not search_terms:
            return {
                "status": "blocked",
                "reason": "NO_PRODUCT_CATEGORIES_IN_SHOPIFY_FEED",
                "products_checked": len(self._latest_products),
                "campaign_writes_performed": False,
            }

        client = MetaAdLibraryClient(
            token, api_version=os.getenv("META_GRAPH_VERSION", "v26.0")
        )
        ads_by_id: dict[str, dict[str, Any]] = {}
        for country in ("DE", "AT"):
            for term in search_terms:
                # Each call is bounded. The daemon retries a failed scan with
                # exponential backoff; no query failure is converted into a trend.
                try:
                    found_ads = await client.search([term], country=country, limit=20)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code not in {400, 401, 403, 404}:
                        raise
                    # A denied archive operation is not a transient outage or a trend.
                    # Normal daily scheduling avoids repeated credential/API probing.
                    return {
                        "status": "partial", "meta": "AD_LIBRARY_OPERATION_REJECTED",
                        "http_status": exc.response.status_code,
                        "tiktok": "not_available_no_authorized_api_configured",
                        "sell_the_trend": "not_available_no_authorized_api_configured",
                        "campaign_writes_performed": False,
                    }
                for ad in found_ads:
                    record = ads_by_id.setdefault(
                        ad.library_id, {"ad": ad, "countries": set(), "terms": set()}
                    )
                    record["countries"].add(country)
                    record["terms"].add(term)

        now = datetime.now(UTC)
        longevity_days: dict[str, int] = {}
        long_running_ads: list[dict[str, Any]] = []
        for observed in ads_by_id.values():
            ad = observed["ad"]
            observed_countries = sorted(observed["countries"])
            if not ad.started_at:
                continue
            try:
                started = datetime.fromisoformat(
                    str(ad.started_at).replace("Z", "+00:00")
                )
                if started.tzinfo is None:
                    started = started.replace(tzinfo=UTC)
                age_days = max(0, (now - started.astimezone(UTC)).days)
            except (TypeError, ValueError, OverflowError):
                continue
            if age_days < 14:
                continue

            ad_text = " ".join(ad.ad_copy).casefold()
            long_running_ads.append(
                {
                    "library_id": ad.library_id,
                    "page_name": ad.page_name,
                    "started_at": ad.started_at,
                    "observed_age_days": age_days,
                    "country_searches": observed_countries,
                    "matched_search_terms": sorted(observed["terms"]),
                    "copy": ad.ad_copy[:2],
                    "snapshot_url": ad.snapshot_url,
                }
            )
            for product in self._latest_products:
                product_id = str(product.get("id", "")).strip()
                title = str(product.get("title", "")).casefold()
                category = str(
                    product.get("product_type")
                    or product.get("google_product_category")
                    or ""
                ).casefold()
                product_tags = product.get("tags", [])
                tags_text = " ".join(
                    str(tag) for tag in product_tags
                ).casefold() if isinstance(product_tags, list) else str(product_tags).casefold()
                tokens = {
                    token
                    for token in re.findall(r"[a-zäöüß]{4,}", " ".join((title, category, tags_text)))
                    if token not in {"dass", "dieser", "dieses", "für", "über", "with", "from"}
                }
                matched = tokens.intersection(
                    set(re.findall(r"[a-zäöüß]{4,}", ad_text))
                )
                if product_id and len(matched) >= 2:
                    longevity_days[product_id] = max(
                        longevity_days.get(product_id, 0), age_days
                    )

        candidates: list[dict[str, Any]] = [
            {
                "product_id": str(product.get("id", "")),
                "title": str(product.get("title", ""))[:200],
                "product_type": str(product.get("product_type", ""))[:160],
                "observed_longest_ad_age_days": longevity_days[str(product.get("id", ""))],
                "review_signal": "public_ad_copy_overlap_and_ad_start_age_only",
            }
            for product in self._latest_products
            if str(product.get("id", "")) in longevity_days
        ]
        candidates.sort(
            key=lambda item: (
                -item["observed_longest_ad_age_days"],
                item["title"].casefold(),
                item["product_id"],
            )
        )
        audit_payload = {
            "source": "official_meta_ad_library",
            "countries": ["DE", "AT"],
            "search_terms": search_terms,
            "public_ads_searched": len(ads_by_id),
            "ads_with_start_age_at_least_14_days": long_running_ads,
            "feed_products_checked": len(self._latest_products),
            "matched_product_candidates": candidates[:50],
            "evidence_limit": (
                "Public ad copy and start dates are not proof of current delivery, "
                "sales, conversion rate, profit, or product demand."
            ),
            "campaign_writes_performed": False,
        }
        await self.audit.record("daemon_competitor_scan", audit_payload)
        return {
            "status": "completed",
            "source": "official_meta_ad_library",
            "countries": ["DE", "AT"],
            "search_terms": search_terms,
            "public_ad_examples": len(ads_by_id),
            "ads_with_start_age_at_least_14_days": len(long_running_ads),
            "feed_products_checked": len(self._latest_products),
            "matched_product_candidates": candidates[:50],
            "tiktok": "not_available_no_authorized_api_configured",
            "sell_the_trend": "not_available_no_authorized_api_configured",
            "minea": "not_available_no_authorized_api_configured",
            "campaign_writes_performed": False,
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
        claim = (await self.audit.get_meta_micro_campaign_claim()
                 if hasattr(self.audit, "get_meta_micro_campaign_claim") else None)
        current = time.monotonic()
        metrics = self._last_results.get("media_buying_plan", {}).get("performance", {})
        plan = control_plan(
            product_count=len(self._latest_products),
            feed_age_seconds=(current - self._evidence_times["feed_diagnostics"]
                              if "feed_diagnostics" in self._evidence_times else None),
            metrics_age_seconds=(current - self._evidence_times["media_buying_plan"]
                                 if "media_buying_plan" in self._evidence_times else None),
            performance_status=metrics.get("status"), campaign_status=(claim or {}).get("status"),
            live_enabled=(os.getenv("ALLOW_MICRO_BUDGET") == "true" and not live_ads_dry_run()),
            daily_cap_eur=configured_daily_budget_limit_eur())
        await self.audit.record("pilot_control_cycle", plan)
        logger.info("pilot_control_cycle %s", json.dumps(plan, separators=(",", ":")))
        if not plan["creative_cycle_allowed"]:
            if plan["next_action"] == "REFRESH_SHOPIFY_FEED":
                self._next_run["feed_diagnostics"] = 0
            elif plan["next_action"] == "REFRESH_META_METRICS":
                self._next_run["media_buying_plan"] = 0
            return {"status": "hold", "reason": plan["reason"], "controller": plan,
                    "retired_campaign": reconciliation, "campaign_writes_performed": False}
        candidates = [
            product
            for product in self._latest_products
            if str(product.get("id", "")).strip()
            and str(product.get("link", "")).strip()
        ]
        if not candidates:
            return {"status": "blocked", "reason": "NO_VALIDATED_CATALOG_PRODUCTS"}
        from .payment_webhooks import PaymentWebhookStore, payment_database
        from .product_selection import read_cost_candidates

        ranked_candidates, selection = await asyncio.to_thread(read_cost_candidates,
            PaymentWebhookStore(payment_database(os.environ)), candidates)
        from .content_engine import content_batch
        from .marketing_director import MarketingDirector
        from .media_registry import MediaRegistry
        from .organic_bridge import read_organic_results

        organic = await read_organic_results()
        await self.audit.record("organic_publisher_evidence", organic)
        from .search_channels import read_google, read_microsoft

        observations = await asyncio.gather(read_google(), read_microsoft(), return_exceptions=True)
        search_channels = {name: value if isinstance(value, dict) else {"status": "unavailable", "error_type": type(value).__name__}
            for name, value in zip(("google", "microsoft"), observations, strict=True)}
        await self.audit.record("search_channel_evidence", search_channels)
        from .cognitive_strategy import CognitiveStrategy

        cognitive = await CognitiveStrategy(self.audit).cycle(ranked_candidates, controller=plan)
        await self.audit.record("cognitive_strategy", cognitive)
        strategy = await asyncio.to_thread(MarketingDirector(self.audit).reconcile,
            ranked_candidates, {"claim": claim, "controller": plan, "organic": organic,
                                "search_channels": search_channels, "cognitive": cognitive})
        await self.audit.record("marketing_director", strategy)
        logger.info("marketing_director %s", json.dumps(strategy, separators=(",", ":")))
        try:
            async with asyncio.timeout(90):
                media_imports = await MediaRegistry(self.audit).seed_existing(candidates, limit=11)
        except TimeoutError:
            media_imports = {"status": "partial", "reason": "MEDIA_IMPORT_CYCLE_TIMEOUT", "publication_confirmed": False}
        await self.audit.record("existing_media_import", media_imports)
        logger.info("existing_media_import %s", json.dumps(media_imports, separators=(",", ":")))
        content = content_batch(ranked_candidates)
        await self.audit.record("content_drafts", content)
        logger.info("content_drafts %s", json.dumps({key: value for key, value in content.items()
                    if key != "drafts"}, separators=(",", ":")))
        await self.audit.record("product_selection", selection)
        logger.info("product_selection %s", json.dumps(selection, separators=(",", ":")))
        if not claim or not claim.get("campaign_id"):
            if not ranked_candidates:
                return {"status": "hold", "reason": "NO_COST_ELIGIBLE_EXPERIMENT_PRODUCTS", "product_selection": selection}
            candidates = ranked_candidates
        product_ids = {str(p.get("id")) for p in self._latest_products}
        product = candidates[0]
        website_mode = os.getenv("PILOT_AD_MODE", "catalog") == "website_sales"
        preview: dict[str, Any] = {}
        if website_mode:
            from .website_ads import website_story

            try:
                _, selected_ids = website_story(candidates, os.getenv("META_PAGE_ID", ""))
            except ValueError as exc:
                return {"status": "blocked", "reason": str(exc)}
            product = next(candidate for candidate in candidates if str(candidate["id"]) == selected_ids[0])
            preview = {"selected_product_ids": selected_ids, "product_count": len(selected_ids),
                       "catalog_required": False, "paid_generation_performed": False}
        publisher_result = await MetaPublisher(self.audit).publish_one(
            creative=None,
            product=product,
            product_ids_in_feed=product_ids,
            products=candidates if website_mode else None,
        )
        brain_result: dict[str, Any] = {"status": "disabled"}
        if website_mode and os.getenv("PILOT_BRAIN_ENABLED") == "true":
            from .autonomous_brain import AutonomousBrain

            scan = self._last_results.get("competitor_scan", {})
            trends = scan.get("matched_product_candidates", []) if scan.get("status") == "completed" else []
            brain_result = await AutonomousBrain(self.audit).cycle(
                candidates, trend_candidates=trends, candidate_products=ranked_candidates)
            await self.audit.record("autonomous_brain", brain_result)
            logger.info("autonomous_brain %s", json.dumps(brain_result, separators=(",", ":")))
        await self.audit.record(
            "daemon_catalog_campaign_attempt",
            {
                "product_scope": "shopify_website_carousel" if website_mode else "configured_meta_product_set",
                "creative_preview": preview,
                "validated_product_count": len(product_ids),
                "publisher": publisher_result,
                "brain": brain_result, "product_selection": selection,
            },
        )
        return {
            "status": publisher_result.get("status", "blocked"),
            "retired_campaign": reconciliation,
            "product_scope": "shopify_website_carousel" if website_mode else "configured_meta_product_set",
            "creative_preview": preview,
            "validated_product_count": len(product_ids),
            "publisher": publisher_result,
                "brain": brain_result, "product_selection": selection,
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

    async def _catalog_access_job(self) -> dict[str, Any]:
        """Diagnose Meta catalog access without requiring or enabling paid spend."""
        if os.getenv("PILOT_AD_MODE", "catalog") == "website_sales":
            return {"status": "not_required", "reason": "WEBSITE_SALES_DOES_NOT_USE_META_CATALOG"}
        result = await MetaPublisher(self.audit).check_catalog_access()
        await self.audit.record("meta_catalog_access_diagnostic", result)
        return result

    async def _metrics_job(self) -> dict[str, Any]:
        performance = (
            await load_meta_performance(self.audit)
            if hasattr(self.audit, "get_meta_micro_campaign_claim")
            else {"status": "audit_not_persistent"}
        )
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
            unverified_measurement_test_authorized=measurement_risk_accepted(os.environ),
            # This optimization pass is intentionally read-only and cannot publish.
            dry_run=True,
        )
        from .order_economics import economics_summary
        from .payment_webhooks import PaymentWebhookStore, payment_database

        claim = (await self.audit.get_meta_micro_campaign_claim()
                 if hasattr(self.audit, "get_meta_micro_campaign_claim") else None)
        ad_spend = (sum(float(row["spend_eur"]) for row in performance.get("metrics", []) if isinstance(row, dict))
                    if performance.get("status") == "collected" else None)
        economics = (await asyncio.to_thread(economics_summary,
            PaymentWebhookStore(payment_database(os.environ)), str(claim.get("campaign_id") or ""), ad_spend)
            if claim else {"status": "no_managed_campaign"})
        daily_budget_limit = configured_daily_budget_limit_eur()
        return {
            "status": "blocked", "order_economics": economics,
            "reason": ("ORDER_ATTRIBUTION_AND_LANDED_COST_REQUIRED"
                       if performance.get("status") == "collected"
                       else "NO_VERIFIED_CHANNEL_METRICS_LOADER"),
            "performance": performance,
            "performance_decision": performance_decision(performance),
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

