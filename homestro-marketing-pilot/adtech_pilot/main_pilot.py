"""FastAPI entry point for the isolated Homestro AdTech pilot service."""

from __future__ import annotations

import asyncio
import base64
import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .creative_factory import BrandKit, CreativeFactory, HistoricalWin, OpenAIProvider
from .feed_manager import Channel, ProductFeedManager
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

ADMIN_HEADER = APIKeyHeader(name="X-Pilot-Admin-Key", auto_error=False)
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
    # This PR is permanently fail-closed. Deployment variables cannot raise spend.
    dry_run = True
    max_budget = 0.0
    execution = AdExecutionEngine(dry_run=dry_run, max_budget_limit=max_budget)
    adapters = platform_adapters or {}
    audit = PlanAuditStore(
        Path(os.getenv("PILOT_AUDIT_DB_PATH", "/tmp/homestro-adtech/audit.sqlite3"))
    )
    tasks: set[asyncio.Task] = set()

    async def require_admin(provided: str | None = Security(ADMIN_HEADER)) -> None:
        if provided is None or not hmac.compare_digest(provided, admin_key):
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
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
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="Homestro AdTech Pilot", version="0.1.0", lifespan=lifespan)

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
            minimum_score=int(os.getenv("PILOT_CREATIVE_MIN_SCORE", "75")),
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
