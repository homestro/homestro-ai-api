"""FastAPI entry point for the isolated Homestro AdTech pilot service."""

from __future__ import annotations

import asyncio
import base64
import hmac
import os
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .creative_factory import BrandKit, CreativeFactory, HistoricalWin, OpenAIProvider
from .daemon import PilotDaemon
from .email_delivery import EmailDelivery
from .feed_manager import Channel, ProductFeedManager
from .github_reporter import GitHubPRReporter
from .media_buyer import (
    AdExecutionEngine,
    MetaAdLibraryClient,
    MetricSnapshot,
    OptimizationPlan,
    OptimizerPolicy,
    PlanAuditStore,
    Platform,
    autopilot_loop,
    build_optimization_plan,
)
from .micro_budget import configured_daily_budget_limit_eur, live_ads_dry_run
from .payment_webhooks import MAX_BODY, TOPICS, receive_payment
from .purchase_guard import PurchaseWatchdog

ADMIN_HEADER = APIKeyHeader(name="X-Pilot-Admin-Key", auto_error=False)
TRIGGER_HEADER = APIKeyHeader(name="X-Pilot-Token", auto_error=False)
MAX_REQUEST_BYTES = 12 * 1024 * 1024


class CreativeProduct(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10_000)
    price: str | None = Field(default=None, max_length=32)
    facts: list[str] = Field(min_length=1, max_length=20)

    @field_validator("facts")
    @classmethod
    def validate_fact_text(cls, value: list[str]) -> list[str]:
        facts = [str(x).strip() for x in value]
        if any(not x or len(x) > 300 for x in facts):
            raise ValueError(
                "each verified product fact must contain 1 to 300 characters"
            )
        return facts


class CreativeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product: CreativeProduct
    platform: str = Field(pattern="^(meta|google|tiktok|pinterest|microsoft|sklik)$")
    product_image_b64: str = Field(min_length=80, max_length=8_000_000)
    logo_image_b64: str = Field(min_length=80, max_length=1_000_000)
    historical_winners: list[HistoricalWin] = Field(default_factory=list, max_length=10)


class ActualOrderExpenses(BaseModel):
    model_config = ConfigDict(extra="forbid")
    order_hash: str = Field(pattern="^[a-f0-9]{64}$")
    fulfillment_eur: str = Field(pattern=r"^[0-9]{1,8}(\.[0-9]{1,2})?$")
    payment_fees_eur: str = Field(pattern=r"^[0-9]{1,8}(\.[0-9]{1,2})?$")
    returns_cost_eur: str = Field(pattern=r"^[0-9]{1,8}(\.[0-9]{1,2})?$")
    other_cost_eur: str = Field(pattern=r"^[0-9]{1,8}(\.[0-9]{1,2})?$")
    actual_costs_confirmed: Literal[True]


class OptimizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metrics: list[MetricSnapshot] = Field(max_length=500)
    current_portfolio_daily_budget_eur: float = Field(ge=0)
    interval_hours: int = Field(default=12, ge=12, le=24)


def _decode_image(value: str, maximum: int) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="INVALID_BASE64_IMAGE") from exc
    if not data or len(data) > maximum:
        raise HTTPException(status_code=413, detail="IMAGE_SIZE_INVALID")
    return data


class EmailConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    observed_at: str = Field(max_length=50)
    evidence_id: str = Field(min_length=1, max_length=100)
    confirmed: Literal[True]


class EmailSendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recipient: str = Field(max_length=254)
    subject: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=15000)
    campaign_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    owner_authorized: Literal[True]


def create_app(
    *,
    admin_key: str | None = None,
    metrics_loader=None,
    platform_adapters: dict[Platform, Any] | None = None,
) -> FastAPI:
    admin_key = admin_key if admin_key is not None else os.getenv("PILOT_ADMIN_KEY", "")
    if len(admin_key) < 32:
        raise RuntimeError("PILOT_ADMIN_KEY must contain at least 32 characters")
    product_feed = ProductFeedManager()
    # Live execution requires both Railway kill switches off and remains capped
    # at the explicitly configured daily limit (hard-capped at €5).
    dry_run = live_ads_dry_run()
    max_budget = configured_daily_budget_limit_eur()
    execution = AdExecutionEngine(dry_run=dry_run, max_budget_limit=max_budget)
    adapters = platform_adapters or {}
    audit = PlanAuditStore(
        Path(os.getenv("PILOT_AUDIT_DB_PATH", "/tmp/homestro-adtech/audit.sqlite3"))
    )
    email_delivery = EmailDelivery(audit, secret=admin_key)
    tasks: set[asyncio.Task] = set()
    stop_daemon = asyncio.Event()
    watchdog = PurchaseWatchdog(audit)

    async def require_admin(provided: str | None = Security(ADMIN_HEADER)) -> None:
        if provided is None or not hmac.compare_digest(provided, admin_key):
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    async def require_trigger(provided: str | None = Security(TRIGGER_HEADER)) -> None:
        # Reuse the persisted administrator secret unless a separate token is set.
        expected = os.getenv("PILOT_TRIGGER_TOKEN", "") or admin_key
        if provided is None or not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(watchdog.run(stop_daemon), name="purchase-watchdog")
        tasks.add(task)
        if os.getenv("PILOT_DAEMON_ENABLED", "true").lower() == "true":
            github_token = os.getenv("PILOT_GITHUB_TOKEN", "")
            reporter = (
                GitHubPRReporter(
                    github_token,
                    repository=os.getenv(
                        "PILOT_GITHUB_REPOSITORY", "homestro/homestro-ai-api"
                    ),
                    pull_request=int(os.getenv("PILOT_GITHUB_PR_NUMBER", "104")),
                )
                if github_token
                else None
            )
            daemon = PilotDaemon(
                audit,
                feed_interval_hours=int(os.getenv("PILOT_FEED_INTERVAL_HOURS", "6")),
                competitor_interval_hours=int(
                    os.getenv("PILOT_COMPETITOR_INTERVAL_HOURS", "24")
                ),
                metrics_interval_hours=int(
                    os.getenv("PILOT_METRICS_INTERVAL_HOURS", "12")
                ),
                reporter=reporter,
            )
            task = asyncio.create_task(daemon.run(stop_daemon), name="pilot-daemon")
            tasks.add(task)
        if (
            os.getenv("PILOT_AUTOPILOT_ENABLED", "false").lower() == "true"
            and metrics_loader is not None
        ):

            async def load():
                loaded = await metrics_loader()
                return loaded.metrics, loaded.current_portfolio_daily_budget_eur

            task = asyncio.create_task(
                autopilot_loop(
                    load_metrics=load,
                    build_plan=lambda metrics, **kw: build_optimization_plan(
                        metrics,
                        policy=OptimizerPolicy(max_budget_limit_eur=max_budget),
                        **kw,
                    ),
                    execution_engine=execution,
                    adapters=adapters,
                    interval_hours=int(
                        os.getenv("PILOT_AUTOPILOT_INTERVAL_HOURS", "12")
                    ),
                    on_cycle=lambda plan, result: _audit_cycle(audit, plan, result),
                )
            )
            tasks.add(task)
        yield
        stop_daemon.set()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="Homestro AdTech Pilot", version="0.1.0", lifespan=lifespan)

    @app.get("/webhooks/shopify/setup")
    async def payment_setup():
        origin = os.getenv("PILOT_PUBLIC_ORIGIN", "").rstrip("/")
        return {"receiver": "shopify_merchant_admin_webhooks",
                "signing_configured": bool(os.getenv("SHOPIFY_WEBHOOK_SECRET")),
                "subscription_registration_confirmed": False,
                "routes": {topic: origin + "/webhooks/shopify/orders" for topic in TOPICS.values()},
                "paid_generation_performed": False}

    @app.post("/webhooks/shopify/{event}")
    async def shopify_payment(event: str, request: Request):
        if event == "orders":
            event = next((route for route, topic in TOPICS.items()
                          if topic == request.headers.get("x-shopify-topic")), "unknown")
        if event not in TOPICS:
            raise HTTPException(404, "UNKNOWN_PAYMENT_EVENT")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                raise HTTPException(413, "WEBHOOK_TOO_LARGE")
        return await receive_payment(raw=bytes(body), headers=request.headers, route=event)

    @app.post("/trigger", dependencies=[Depends(require_trigger)])
    async def trigger():
        return await watchdog.cycle()

    @app.get("/pilot/status", dependencies=[Depends(require_admin)])
    async def pilot_status():
        return {"purchase_watchdog": watchdog.last_result,
                "purchase_source": os.getenv("PILOT_PURCHASE_SOURCE", "shopify_api"),
                "webhook_signing_configured": bool(os.getenv("SHOPIFY_WEBHOOK_SECRET")),
                "webhook_routes": ["/webhooks/shopify/" + name for name in TOPICS],
                "ad_mode": os.getenv("PILOT_AD_MODE", "catalog"),
                "fresh_purchase_window_minutes": 15, "watchdog_interval_seconds": 60,
                "paid_generation_enabled": os.getenv("PILOT_CREATIVE_ENABLED", "false").lower() == "true"}

    @app.get("/pilot/brain", dependencies=[Depends(require_admin)])
    async def pilot_brain():
        from .brain_status import operating_report

        latest = await audit.latest_brain_evidence()
        claim = await audit.get_meta_micro_campaign_claim()
        return operating_report(latest, claim, daily_cap_eur=configured_daily_budget_limit_eur())

    @app.get("/pilot/marketing", dependencies=[Depends(require_admin)])
    async def pilot_marketing(limit: int = 50):
        from .marketing_director import MarketingDirector

        return await asyncio.to_thread(MarketingDirector(audit).report, limit=limit)

    @app.get("/pilot/search/drafts", dependencies=[Depends(require_admin)])
    async def pilot_search_drafts():
        from .search_campaigns import SearchCampaignDrafts

        return {"drafts": await asyncio.to_thread(SearchCampaignDrafts(audit).list),
                "authorized_spend_eur": 0, "writes_performed": False}

    @app.post("/pilot/search/drafts/{draft_id}/validate-google", dependencies=[Depends(require_admin)])
    async def validate_search_draft(draft_id: str):
        from .search_campaigns import SearchCampaignDrafts, validate_google_draft

        drafts = await asyncio.to_thread(SearchCampaignDrafts(audit).list)
        draft = next((row for row in drafts if row['id'] == draft_id and row['channel'] == 'google'), None)
        if draft is None:
            raise HTTPException(404, "CURRENT_GOOGLE_DRAFT_NOT_FOUND")
        # Five EUR is a proposed schema fixture only; validateOnly cannot create a budget.
        result = await validate_google_draft(draft, proposed_daily_eur='5.00')
        await audit.record("google_draft_validation", result)
        return result

    @app.get("/pilot/search/drafts/{draft_id}/request-template", dependencies=[Depends(require_admin)])
    async def search_request_template(draft_id: str):
        from .search_campaigns import (
            SearchCampaignDrafts,
            google_validation_request,
            microsoft_request_templates,
        )

        drafts = await asyncio.to_thread(SearchCampaignDrafts(audit).list)
        draft = next((row for row in drafts if row['id'] == draft_id), None)
        if draft is None:
            raise HTTPException(404, "CURRENT_SEARCH_DRAFT_NOT_FOUND")
        setting = 'GOOGLE_ADS_CUSTOMER_ID' if draft['channel'] == 'google' else 'MICROSOFT_ADS_ACCOUNT_ID'
        account = os.environ.get(setting, '').replace('-', '')
        if not account:
            return {"status": "not_configured", "missing_settings": [setting], "writes_performed": False}
        try:
            compiler = google_validation_request if draft['channel'] == 'google' else microsoft_request_templates
            request = compiler(draft, account, proposed_daily_eur='5.00')
        except (ValueError, ArithmeticError) as exc:
            raise HTTPException(422, "SEARCH_TEMPLATE_REQUIRES_REVIEW") from exc
        return {"draft_id": draft_id, "revision": draft['revision'], "request_template": request,
                "targets_resolved": False, "ready_to_submit": False,
                "proposed_schema_budget_eur": 5, "authorized_spend_eur": 0, "writes_performed": False}

    @app.get("/pilot/media", dependencies=[Depends(require_admin)])
    async def pilot_media():
        from .media_registry import MediaRegistry
        from .publisher_handoff import PublisherHandoff

        return {"assets": await asyncio.to_thread(MediaRegistry(audit).list),
                "publisher_handoff": await asyncio.to_thread(PublisherHandoff(audit).records),
                "generation_performed": False}

    @app.post("/pilot/email/consent", dependencies=[Depends(require_admin)])
    async def email_consent(body: EmailConsentRequest):
        try:
            return await asyncio.to_thread(email_delivery.consent, body.email,
                observed_at=body.observed_at, evidence_id=body.evidence_id, confirmed=body.confirmed)
        except ValueError as exc:
            raise HTTPException(422, "INVALID_CONSENT_EVIDENCE") from exc

    @app.post("/pilot/email/send", dependencies=[Depends(require_admin)])
    async def email_send(body: EmailSendRequest):
        try:
            return await email_delivery.send(**body.model_dump(), env=os.environ)
        except ValueError as exc:
            raise HTTPException(422, "INVALID_EMAIL_SEND_CONFIGURATION_OR_CONTENT") from exc

    @app.get("/email/unsubscribe/{recipient}/{signature}", response_class=HTMLResponse)
    async def email_unsubscribe_form(recipient: str, signature: str):
        if len(recipient) != 64 or any(char not in '0123456789abcdef' for char in recipient) or not hmac.compare_digest(
                email_delivery.signature(recipient), signature):
            raise HTTPException(404, "INVALID_UNSUBSCRIBE_LINK")
        return HTMLResponse('<!doctype html><html lang="de"><meta charset="utf-8"><title>Abmelden</title>'
            '<form method="post"><button type="submit">E-Mail-Marketing abmelden</button></form></html>',
            headers={"Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'"})

    @app.post("/email/unsubscribe/{recipient}/{signature}")
    async def email_unsubscribe(recipient: str, signature: str):
        try:
            return await asyncio.to_thread(email_delivery.unsubscribe, recipient, signature)
        except ValueError as exc:
            raise HTTPException(404, "INVALID_UNSUBSCRIBE_LINK") from exc

    @app.get("/pilot/economics", dependencies=[Depends(require_admin)])
    async def pilot_economics():
        from .order_economics import economics_summary
        from .payment_webhooks import PaymentWebhookStore, payment_database
        from .performance_loader import load_meta_performance

        claim = await audit.get_meta_micro_campaign_claim()
        performance = await load_meta_performance(audit)
        spend = (sum(row["spend_eur"] for row in performance.get("metrics", []))
                 if performance.get("status") == "collected" else None)
        return await asyncio.to_thread(economics_summary, PaymentWebhookStore(payment_database(os.environ)),
                                       str((claim or {}).get("campaign_id") or ""), spend)

    @app.get("/pilot/economics/orders", dependencies=[Depends(require_admin)])
    async def pilot_order_cost_status():
        from .payment_webhooks import PaymentWebhookStore, payment_database

        def read():
            with closing(PaymentWebhookStore(payment_database(os.environ)).connect()) as db:
                rows = db.execute("SELECT o.order_hash,o.campaign,o.experiment,o.paid_at,o.blocked,"
                                  "o.cogs IS NULL,e.order_hash IS NULL FROM pilot_order_economics o "
                                  "LEFT JOIN pilot_order_expenses e ON e.order_hash=o.order_hash "
                                  "ORDER BY o.paid_at DESC LIMIT 100").fetchall()
            return {"orders": [dict(zip(("order_hash", "campaign_id", "experiment", "paid_at", "invalidated",
                                         "unit_cost_missing", "actual_expenses_missing"), row)) for row in rows]}
        return await asyncio.to_thread(read)

    @app.post("/pilot/economics/expenses", dependencies=[Depends(require_admin)])
    async def actual_order_expenses(body: ActualOrderExpenses):
        from datetime import UTC, datetime

        from .payment_webhooks import PaymentWebhookStore, payment_database

        def write():
            with closing(PaymentWebhookStore(payment_database(os.environ)).connect()) as db, db:
                if not db.execute("SELECT 1 FROM pilot_order_economics WHERE order_hash=?", (body.order_hash,)).fetchone():
                    raise HTTPException(404, "UNKNOWN_ATTRIBUTED_ORDER")
                db.execute("INSERT INTO pilot_order_expenses VALUES (?,?,?,?,?,?) ON CONFLICT(order_hash) DO UPDATE SET "
                           "fulfillment=excluded.fulfillment,fees=excluded.fees,returns_cost=excluded.returns_cost,"
                           "other_cost=excluded.other_cost,recorded_at=excluded.recorded_at",
                           (body.order_hash, body.fulfillment_eur, body.payment_fees_eur, body.returns_cost_eur,
                            body.other_cost_eur, datetime.now(UTC).isoformat()))
            return {"recorded": True, "budget_writes": False, "scale_authorized": False}
        return await asyncio.to_thread(write)

    @app.middleware("http")
    async def request_size_limit(request: Request, call_next):
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse(
                status_code=400, content={"detail": "INVALID_CONTENT_LENGTH"}
            )
        if length > MAX_REQUEST_BYTES:
            return JSONResponse(
                status_code=413, content={"detail": "REQUEST_TOO_LARGE"}
            )
        return await call_next(request)

    @app.get("/healthz")
    async def healthz():
        return {
            "ok": True,
            "service": "homestro-adtech-pilot",
            "dry_run": execution.dry_run,
            "max_budget_limit_eur": execution.max_budget_limit,
            "mutations_enabled": bool(adapters) and not execution.dry_run,
            "daemon_enabled": os.getenv("PILOT_DAEMON_ENABLED", "true").lower()
            == "true",
            "micro_budget_arm_requested": (
                os.getenv("ALLOW_MICRO_BUDGET", "false").strip().lower() == "true"
                and not live_ads_dry_run()
                and max_budget >= 5.0
            ),
            "micro_budget_daily_budget_limit_eur": max_budget,
            "micro_budget_daily_budget_eur": 5.0,
            "micro_budget_window_days": 7,
            "micro_budget_planned_total_eur": 35.0,
        }

    @app.post("/feed/validate", dependencies=[Depends(require_admin)])
    async def validate_feed(request: Request):
        body = await request.body()
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="FEED_TOO_LARGE")
        report = product_feed.parse(body, request.headers.get("content-type"))
        return report.model_dump(mode="json")

    @app.post("/feed/prepare/{channel}", dependencies=[Depends(require_admin)])
    async def prepare_feed(channel: Channel, request: Request):
        body = await request.body()
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="FEED_TOO_LARGE")
        report = product_feed.parse(body, request.headers.get("content-type"))
        prepared = product_feed.prepare_channels(report)
        return {
            "channel": channel.value,
            "mode": "prepared_not_uploaded",
            "report": report.model_dump(mode="json"),
            "products": prepared[channel.value],
            "platform_write_performed": False,
        }

    @app.post("/optimizer/plan", dependencies=[Depends(require_admin)])
    async def optimizer_plan(body: OptimizationRequest):
        plan = build_optimization_plan(
            body.metrics,
            current_portfolio_daily_budget_eur=body.current_portfolio_daily_budget_eur,
            policy=OptimizerPolicy(max_budget_limit_eur=max_budget),
            interval_hours=body.interval_hours,
        )
        record_id = await audit.record("optimization_plan", plan)
        return {"plan_id": record_id, "plan": plan.model_dump(mode="json")}

    @app.post("/optimizer/execute", dependencies=[Depends(require_admin)])
    async def optimizer_execute(plan: OptimizationPlan):
        result = await execution.execute(plan, adapters)
        record_id = await audit.record("execution_result", result)
        return {"audit_id": record_id, "result": result.model_dump(mode="json")}

    @app.get("/optimizer/audit", dependencies=[Depends(require_admin)])
    async def optimizer_audit(limit: int = 50):
        return {"records": await audit.list(limit)}

    @app.get("/competitors/meta", dependencies=[Depends(require_admin)])
    async def competitor_meta(terms: list[str], country: str = "DE", limit: int = 25):
        token = os.getenv("META_AD_LIBRARY_ACCESS_TOKEN", "")
        if not token:
            raise HTTPException(
                status_code=503, detail="META_AD_LIBRARY_NOT_CONFIGURED"
            )
        client = MetaAdLibraryClient(
            token, api_version=os.getenv("META_GRAPH_VERSION", "v26.0")
        )
        ads = await client.search(terms, country=country, limit=limit)
        return {
            "ads": [ad.model_dump(mode="json") for ad in ads],
            "evidence_limit": "Public ad examples and run dates only; competitor conversions, spend and ROAS are not exposed here.",
        }

    @app.post("/creatives/generate", dependencies=[Depends(require_admin)])
    async def generate_creative(body: CreativeRequest):
        if os.getenv("PILOT_CREATIVE_ENABLED", "false").lower() != "true":
            raise HTTPException(status_code=503, detail="CREATIVE_GENERATION_DISABLED")
        key = os.getenv("OPENAI_API_KEY", "")
        if not key:
            raise HTTPException(status_code=503, detail="OPENAI_API_KEY_MISSING")
        provider = OpenAIProvider(
            key,
            text_model=os.getenv("PILOT_LLM_MODEL", "gpt-4.1-mini"),
            image_model=os.getenv("PILOT_IMAGE_MODEL", "gpt-image-1"),
        )
        brand = BrandKit(
            primary_hex=os.getenv("HOMESTRO_BRAND_PRIMARY", "#246B4B"),
            secondary_hex=os.getenv("HOMESTRO_BRAND_SECONDARY", "#F2EFE7"),
            accent_hex=os.getenv("HOMESTRO_BRAND_ACCENT", "#D8A83E"),
        )
        factory = CreativeFactory(
            llm=provider,
            image_editor=provider,
            brand=brand,
            output_dir=Path(os.getenv("PILOT_CREATIVE_DIR", "/data/adtech-creatives")),
            minimum_score=int(os.getenv("PILOT_CREATIVE_MIN_SCORE", "85")),
        )
        try:
            result = await factory.create(
                product=body.product.model_dump(),
                platform=body.platform,
                product_image=_decode_image(body.product_image_b64, 6_000_000),
                logo_image=_decode_image(body.logo_image_b64, 750_000),
                historical_winners=body.historical_winners,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return result.model_dump(mode="json")

    app.state.execution_engine = execution
    app.state.platform_adapters = adapters
    app.state.audit_store = audit
    return app


async def _audit_cycle(
    audit: PlanAuditStore, plan: OptimizationPlan, result: Any
) -> None:
    await audit.record(
        "autopilot_plan",
        {
            "plan": plan.model_dump(mode="json"),
            "execution": result.model_dump(mode="json"),
        },
    )


app = create_app()
