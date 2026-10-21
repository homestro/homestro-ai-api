"""Transparent, product-agnostic ranking of verified Shopify funnel signals.

Scores are prioritization points, not predicted conversion probabilities. This
module never creates campaigns or recommends spend when evidence is missing.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProductIntentSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str = Field(min_length=1, max_length=128)
    views: int = Field(default=0, ge=0)
    add_to_cart: int = Field(default=0, ge=0)
    initiate_checkout: int = Field(default=0, ge=0)
    purchases: int = Field(default=0, ge=0)
    contribution_margin_eur: Decimal | None = None
    available: bool
    ingestion_verified: bool
    observed_at: datetime

    @field_validator("observed_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("observed_at must include a timezone")
        return value

    @field_validator("contribution_margin_eur")
    @classmethod
    def require_finite_margin(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and (not value.is_finite()):
            raise ValueError("contribution margin must be finite")
        return value


class ProductIntentRank(BaseModel):
    product_id: str
    score: float
    eligible_for_review: bool
    blockers: list[str] = Field(default_factory=list)
    evidence: dict[str, int]


def rank_product_intent(
    snapshots: list[ProductIntentSnapshot],
    *,
    now: datetime | None = None,
    max_age: timedelta = timedelta(hours=72),
) -> list[ProductIntentRank]:
    """Rank products from fresh, verified observed events; never infer intent from titles.

    A candidate needs a real checkout or at least three AddToCart events, verified
    ingestion, current stock and positive known contribution margin. A verified
    Purchase is strongest evidence. Clicks/views alone never qualify a product.
    """
    as_of = now or datetime.now(UTC)
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ValueError("now must include a timezone")
    ranked: list[ProductIntentRank] = []
    for item in snapshots:
        blockers: list[str] = []
        age = as_of - item.observed_at.astimezone(UTC)
        if age < timedelta(0) or age > max_age:
            blockers.append("EVENT_DATA_STALE_OR_FUTURE")
        if not item.ingestion_verified:
            blockers.append("EVENT_INGESTION_NOT_VERIFIED")
        if not item.available:
            blockers.append("PRODUCT_NOT_AVAILABLE")
        if item.contribution_margin_eur is None or item.contribution_margin_eur <= 0:
            blockers.append("POSITIVE_MARGIN_NOT_VERIFIED")
        if item.purchases == 0 and item.initiate_checkout == 0 and item.add_to_cart < 3:
            blockers.append("INSUFFICIENT_HIGH_INTENT_EVENTS")

        score = (
            item.purchases * 100.0
            + item.initiate_checkout * 25.0
            + item.add_to_cart * 5.0
            + item.views * 0.1
        )
        ranked.append(
            ProductIntentRank(
                product_id=item.product_id,
                score=round(score, 2),
                eligible_for_review=not blockers,
                blockers=blockers,
                evidence={
                    "views": item.views,
                    "add_to_cart": item.add_to_cart,
                    "initiate_checkout": item.initiate_checkout,
                    "purchases": item.purchases,
                },
            )
        )
    return sorted(
        ranked,
        key=lambda item: (
            not item.eligible_for_review,
            -item.score,
            item.product_id,
        ),
    )
