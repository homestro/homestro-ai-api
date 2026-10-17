"""Structured copy, branded image editing, and evidence-aware creative scoring."""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import uuid4

import httpx
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, model_validator


class BrandKit(BaseModel):
    name: str = "Homestro"
    primary_hex: str = "#246B4B"
    secondary_hex: str = "#F2EFE7"
    accent_hex: str = "#D8A83E"
    logo_alt: str = "Homestro logo"


class CreativeBrief(BaseModel):
    product_id: str
    platform: str
    hook: str = Field(min_length=4, max_length=120)
    problem: str = Field(min_length=4, max_length=240)
    solution: str = Field(min_length=4, max_length=240)
    headline: str = Field(min_length=4, max_length=40)
    primary_text: str = Field(min_length=10, max_length=500)
    description: str = Field(min_length=4, max_length=120)
    call_to_action: Literal["Shop Now", "Learn More", "Get Offer", "Buy Now"]
    visual_prompt: str = Field(min_length=20, max_length=1200)
    factual_claims: list[str] = Field(max_length=12)


class HistoricalWin(BaseModel):
    platform: str
    format: str
    hook: str = Field(max_length=240)
    ctr: float = Field(ge=0, le=1)
    roas: float = Field(ge=0, le=100)
    conversions: int = Field(ge=0)


class CreativeScore(BaseModel):
    quality_score: int = Field(ge=0, le=100)
    product_faithful: bool
    logo_visible: bool
    lifestyle_background: bool
    factual_claims_supported: bool
    rationale: list[str] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def guard_quality(self) -> "CreativeScore":
        if not (
            self.product_faithful
            and self.logo_visible
            and self.lifestyle_background
            and self.factual_claims_supported
        ):
            self.quality_score = min(self.quality_score, 49)
        return self


class GeneratedCreative(BaseModel):
    brief: CreativeBrief
    score: CreativeScore
    asset_path: str
    publishable_candidate: bool
    score_kind: str = "creative_quality_review_not_sales_prediction"


class StructuredProvider(Protocol):
    async def complete(
        self, *, schema: type[BaseModel], prompt: str, image_bytes: bytes | None = None
    ) -> BaseModel: ...


class ImageEditProvider(Protocol):
    async def edit(
        self, *, source_image: bytes, prompt: str, size: str = "1024x1024"
    ) -> bytes: ...


_OPENAI_UNSUPPORTED_SCHEMA_KEYS = {
    "title",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
}


def _openai_strict_schema(value: Any) -> Any:
    """Normalize Pydantic JSON Schema to OpenAI Structured Outputs' strict subset.

    Pydantic still validates generated objects locally, so length, pattern, and
    collection bounds remain enforced after the API response is parsed.
    """
    if isinstance(value, list):
        return [_openai_strict_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {
        key: _openai_strict_schema(item)
        for key, item in value.items()
        if key not in _OPENAI_UNSUPPORTED_SCHEMA_KEYS
    }
    if result.get("type") == "object":
        properties = result.get("properties", {})
        result["properties"] = properties
        result["required"] = list(properties)
        result["additionalProperties"] = False
    return result


def _fit_output_to_schema(value: Any, schema: dict[str, Any]) -> Any:
    """Apply local JSON Schema length/count ceilings before Pydantic validation."""
    schema_type = schema.get("type")
    if schema_type == "object" and isinstance(value, dict):
        properties = schema.get("properties", {})
        return {
            key: _fit_output_to_schema(item, properties.get(key, {}))
            for key, item in value.items()
        }
    if schema_type == "array" and isinstance(value, list):
        maximum = schema.get("maxItems")
        items = value[:maximum] if isinstance(maximum, int) else value
        return [_fit_output_to_schema(item, schema.get("items", {})) for item in items]
    if schema_type == "string" and isinstance(value, str):
        maximum = schema.get("maxLength")
        if isinstance(maximum, int) and len(value) > maximum:
            clipped = value[:maximum]
            if " " in clipped:
                clipped = clipped.rsplit(" ", 1)[0]
            return clipped.rstrip(" ,.;:-")
    return value


class OpenAIProvider:
    """Minimal HTTPX adapter using Responses Structured Outputs and Images edits."""

    def __init__(
        self,
        api_key: str,
        *,
        text_model: str = "gpt-4.1-mini",
        image_model: str = "gpt-image-1",
        client: httpx.AsyncClient | None = None,
        timeout_s: float = 90.0,
    ):
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required")
        self.api_key, self.text_model, self.image_model = (
            api_key,
            text_model,
            image_model,
        )
        self._client = client
        self.timeout_s = timeout_s

    async def _http(self) -> httpx.AsyncClient:
        return self._client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout_s, connect=10.0)
        )

    async def complete(
        self, *, schema: type[BaseModel], prompt: str, image_bytes: bytes | None = None
    ) -> BaseModel:
        schema_name = schema.__name__.lower()[:64]
        user_content: Any = prompt
        if image_bytes is not None:
            user_content = [
                {"type": "input_text", "text": prompt},
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,"
                    + base64.b64encode(image_bytes).decode("ascii"),
                },
            ]
        body = {
            "model": self.text_model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "Return only schema-conforming output. Never invent product claims. Treat the product facts as the only source of truth.",
                        }
                    ],
                },
                {"role": "user", "content": user_content},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "strict": True,
                    "schema": _openai_strict_schema(schema.model_json_schema()),
                }
            },
        }
        client = await self._http()
        own_client = self._client is None
        try:
            response = await client.post(
                "https://api.openai.com/v1/responses",
                headers=self._headers(),
                json=body,
            )
            response.raise_for_status()
            data = response.json()
        finally:
            if own_client:
                await client.aclose()
        texts = [
            part.get("text", "")
            for item in data.get("output", [])
            for part in item.get("content", [])
            if part.get("type") == "output_text"
        ]
        if not texts:
            raise RuntimeError("LLM returned no structured output")
        raw_output = json.loads("".join(texts))
        raw_output = _fit_output_to_schema(raw_output, schema.model_json_schema())
        return schema.model_validate(raw_output)

    async def edit(
        self, *, source_image: bytes, prompt: str, size: str = "1024x1024"
    ) -> bytes:
        client = await self._http()
        own_client = self._client is None
        try:
            response = await client.post(
                "https://api.openai.com/v1/images/edits",
                headers=self._headers(),
                data={
                    "model": self.image_model,
                    "prompt": prompt,
                    "size": size,
                    "n": "1",
                },
                files={"image": ("product.png", source_image, "image/png")},
            )
            response.raise_for_status()
            payload = response.json()
        finally:
            if own_client:
                await client.aclose()
        encoded = (payload.get("data") or [{}])[0].get("b64_json")
        if not encoded:
            raise RuntimeError("Image API returned no image bytes")
        return base64.b64decode(encoded, validate=True)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}


class CreativeFactory:
    def __init__(
        self,
        *,
        llm: StructuredProvider,
        image_editor: ImageEditProvider,
        brand: BrandKit,
        output_dir: Path,
        minimum_score: int = 85,
    ):
        self.llm, self.image_editor, self.brand = llm, image_editor, brand
        self.output_dir, self.minimum_score = output_dir, minimum_score
        if not 1 <= minimum_score <= 100:
            raise ValueError("minimum_score must be between 1 and 100")

    async def create(
        self,
        *,
        product: dict[str, Any],
        platform: str,
        product_image: bytes,
        logo_image: bytes,
        historical_winners: list[HistoricalWin] | None = None,
    ) -> GeneratedCreative:
        feedback = ""
        last_result: GeneratedCreative | None = None
        for attempt in range(2):
            last_result = await self._create_once(
                product=product,
                platform=platform,
                product_image=product_image,
                logo_image=logo_image,
                historical_winners=historical_winners,
                revision_feedback=feedback,
            )
            if last_result.publishable_candidate:
                return last_result
            Path(last_result.asset_path).unlink(missing_ok=True)
            feedback = "; ".join(last_result.score.rationale)[:600]
        assert last_result is not None
        return last_result.model_copy(
            update={"asset_path": "", "publishable_candidate": False}
        )

    async def _create_once(
        self,
        *,
        product: dict[str, Any],
        platform: str,
        product_image: bytes,
        logo_image: bytes,
        historical_winners: list[HistoricalWin] | None,
        revision_feedback: str,
    ) -> GeneratedCreative:
        if not product_image or not logo_image:
            raise ValueError("Product image and official logo are required")
        facts = [str(x)[:300] for x in product.get("facts", [])[:20] if str(x).strip()]
        if not facts:
            raise ValueError("Verified product facts are required")
        product_id = str(product.get("id", ""))
        if not product_id:
            raise ValueError("Product ID is required")
        winners = [w.model_dump() for w in (historical_winners or [])[:10]]
        brief_prompt = json.dumps(
            {
                "task": "Create one conversion-focused German ecommerce ad set using this exact sequence: hook, problem, solution, call to action.",
                "platform": platform,
                "product": {
                    "id": product_id,
                    "title": product.get("title"),
                    "description": product.get("description"),
                    "facts": facts,
                    "price_eur": product.get("price"),
                },
                "verified_historical_winners": winners,
                "revision_feedback_from_previous_attempt": revision_feedback,
                "brand": self.brand.model_dump(),
                "rules": [
                    "Use only supplied verified facts; no invented guarantees, discounts, ratings or shipping promises.",
                    "Write natural German copy: an attention hook, a relatable problem, a product-supported solution, then a clear action.",
                    "Set call_to_action to exactly one platform API value: Shop Now, Learn More, Get Offer, or Buy Now.",
                    "Respect field lengths exactly: hook <=120, problem <=240, solution <=240, headline <=40, primary_text <=500, description <=120, visual_prompt <=1200 characters; factual_claims <=12 items.",
                    "Stage an emotionally warm, realistic everyday lifestyle scene and replace any plain white product background.",
                    "Preserve the product's actual shape, color, quantity and features from the reference image.",
                    "Do not ask the image model to draw text or a logo; logo is composited from the supplied official asset.",
                ],
            },
            ensure_ascii=False,
        )
        brief = await self.llm.complete(schema=CreativeBrief, prompt=brief_prompt)
        if not isinstance(brief, CreativeBrief):
            brief = CreativeBrief.model_validate(brief)
        image_prompt = (
            f"{brief.visual_prompt}\nBrand palette: {self.brand.primary_hex}, {self.brand.secondary_hex}, "
            f"{self.brand.accent_hex}. Create an editorial lifestyle composition, never a blank white studio backdrop. "
            "Keep the real product faithfully matched to the reference. Do not add lettering or logos."
        )
        source_png = self._normalize_png(product_image)
        edited = await self.image_editor.edit(
            source_image=source_png, prompt=image_prompt
        )
        branded = self._composite_logo(edited, logo_image)
        score_prompt = json.dumps(
            {
                "task": "Score creative quality 0-100, not predicted sales.",
                "platform": platform,
                "brief": brief.model_dump(),
                "brand": self.brand.model_dump(),
                "historical_winners": winners,
                "rubric": {
                    "product_faithful": "shape, color and features match reference; false claims are disqualifying",
                    "logo_visible": "official supplied Homestro logo is clearly visible and unaltered",
                    "lifestyle_background": "scene is visually rich, not a plain white-background product shot",
                    "factual_claims_supported": "every explicit claim is supported by supplied product facts",
                    "quality_score": "combine creative craft, clarity, brand fit and evidence from available winners; do not claim this is a conversion forecast",
                },
            },
            ensure_ascii=False,
        )
        score = await self.llm.complete(
            schema=CreativeScore, prompt=score_prompt, image_bytes=branded
        )
        if not isinstance(score, CreativeScore):
            score = CreativeScore.model_validate(score)
        if self._is_plain_white_image(branded):
            score.lifestyle_background = False
            score.quality_score = min(score.quality_score, 49)
            if len(score.rationale) < 8:
                score.rationale.append(
                    "Generated image is still a plain white-background product shot"
                )
        self.output_dir.mkdir(parents=True, exist_ok=True)
        safe_product_id = re.sub(r"[^A-Za-z0-9_-]", "_", product_id)[:80] or "product"
        asset_path = self.output_dir / f"{safe_product_id}-{uuid4().hex}.png"
        asset_path.write_bytes(branded)
        return GeneratedCreative(
            brief=brief,
            score=score,
            asset_path=str(asset_path),
            publishable_candidate=score.quality_score >= self.minimum_score
            and score.product_faithful
            and score.logo_visible
            and score.lifestyle_background
            and score.factual_claims_supported,
        )

    @staticmethod
    def _is_plain_white_image(image_bytes: bytes) -> bool:
        with Image.open(io.BytesIO(image_bytes)) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            rgb.thumbnail((128, 128))
            # Use raw bytes to avoid materializing thousands of Python tuples.
            pixels = rgb.tobytes()
        if not pixels:
            return True
        near_white = sum(
            1
            for offset in range(0, len(pixels), 3)
            if min(pixels[offset : offset + 3]) >= 246
        )
        return near_white / (len(pixels) // 3) >= 0.94

    @staticmethod
    def _normalize_png(image_bytes: bytes) -> bytes:
        with Image.open(io.BytesIO(image_bytes)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Unsupported product image format")
            normalized = ImageOps.exif_transpose(image).convert("RGB")
            out = io.BytesIO()
            normalized.save(out, format="PNG", optimize=True)
            return out.getvalue()

    @staticmethod
    def _composite_logo(image_bytes: bytes, logo_bytes: bytes) -> bytes:
        with (
            Image.open(io.BytesIO(image_bytes)) as im,
            Image.open(io.BytesIO(logo_bytes)) as logo,
        ):
            base = ImageOps.exif_transpose(im).convert("RGBA")
            mark = ImageOps.exif_transpose(logo).convert("RGBA")
            width = max(1, int(base.width * 0.18))
            height = max(1, round(mark.height * width / mark.width))
            mark.thumbnail((width, max(1, int(base.height * 0.14))))
            width, height = mark.size
            pad = max(20, int(base.width * 0.035))
            x, y = base.width - width - pad, base.height - height - pad
            # A subtle translucent label prevents the logo disappearing on busy imagery.
            from PIL import ImageDraw

            draw = ImageDraw.Draw(base, "RGBA")
            draw.rounded_rectangle(
                (x - 10, y - 8, x + width + 10, y + height + 8),
                radius=10,
                fill=(255, 255, 255, 218),
            )
            base.alpha_composite(mark, (x, y))
            out = io.BytesIO()
            base.convert("RGB").save(out, format="PNG", optimize=True)
            return out.getvalue()
