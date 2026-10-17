"""Validated, channel-neutral product feeds for Homestro's ad pilot.

This module prepares data only. Platform upload is handled by explicit adapters and
is never performed during parsing or validation.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Any
from urllib.parse import unquote, urlsplit

from defusedxml import ElementTree as SafeET
from pydantic import BaseModel, ConfigDict, Field, field_validator


class Channel(StrEnum):
    META = "meta"
    GOOGLE = "google"
    TIKTOK = "tiktok"
    PINTEREST = "pinterest"
    MICROSOFT = "microsoft"
    SKLIK = "sklik"


class FeedProduct(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    link: str
    image_link: str | None = None
    price: Decimal
    currency: str = "EUR"
    availability: str
    brand: str | None = None
    gtin: str | None = None
    mpn: str | None = None
    product_type: str | None = None
    google_product_category: str | None = None
    condition: str = "new"
    identifier_exists: bool | None = None
    facts: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("price", mode="before")
    @classmethod
    def parse_price(cls, value: Any) -> Decimal:
        if isinstance(value, str):
            value = re.sub(r"\s*(EUR|€)\s*$", "", value.strip(), flags=re.I)
            value = value.replace(",", ".")
        try:
            amount = Decimal(str(value))
        except (InvalidOperation, ValueError, TypeError) as exc:
            raise ValueError("price must be a decimal amount") from exc
        if not amount.is_finite() or amount <= 0:
            raise ValueError("price must be greater than zero")
        return amount.quantize(Decimal("0.01"))

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value: Any) -> str:
        text = str(value or "EUR").upper().strip()
        return text.split()[0] if text else "EUR"

    @field_validator("availability", mode="before")
    @classmethod
    def normalize_availability(cls, value: Any) -> str:
        text = str(value or "").strip().lower().replace(" ", "_")
        return {
            "instock": "in_stock",
            "outofstock": "out_of_stock",
            "preorder": "preorder",
        }.get(text, text)

    @field_validator("gtin", mode="before")
    @classmethod
    def normalize_gtin(cls, value: Any) -> str | None:
        if value is None or str(value).strip() == "":
            return None
        text = re.sub(r"\s+", "", str(value))
        if not re.fullmatch(r"(?:\d{8}|\d{12}|\d{13}|\d{14})", text):
            raise ValueError("GTIN must contain 8, 12, 13 or 14 digits")
        digits = [int(x) for x in text]
        check_digit = digits.pop()
        checksum = sum(
            n * (3 if index % 2 == 0 else 1) for index, n in enumerate(reversed(digits))
        )
        if (10 - checksum % 10) % 10 != check_digit:
            raise ValueError("GTIN check digit is invalid")
        return text

    @field_validator("link")
    @classmethod
    def validate_product_url(cls, value: str) -> str:
        # Reject characters that URL libraries commonly percent-encode silently.
        if any(ord(c) < 0x21 or c in '<>"{}|\\^`' for c in value):
            raise ValueError(
                "URL contains whitespace, control or unsupported characters"
            )
        if re.search(r"%(?![0-9A-Fa-f]{2})", value):
            raise ValueError("URL contains an invalid percent escape")
        parsed = urlsplit(value)
        decoded_path = unquote(parsed.path)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "homestro.de"
            or parsed.username
            or parsed.password
            or not re.fullmatch(
                r"/products/[A-Za-z0-9][A-Za-z0-9._~%-]{0,255}", parsed.path
            )
            or "/" in decoded_path.removeprefix("/products/")
            or ".." in decoded_path
            or parsed.fragment
        ):
            raise ValueError(
                "URL must be a canonical https://homestro.de/products/... URL"
            )
        return value

    @field_validator("image_link")
    @classmethod
    def validate_image_url(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or any(ord(c) < 0x21 for c in value)
        ):
            raise ValueError("image URL must be an absolute HTTPS URL")
        return value


class FeedIssue(BaseModel):
    severity: str
    code: str
    product_id: str | None = None
    field: str | None = None
    message: str


class FeedReport(BaseModel):
    products: list[FeedProduct]
    issues: list[FeedIssue]
    rejected_rows: int = 0
    source_format: str

    @property
    def valid(self) -> bool:
        return self.rejected_rows == 0 and not any(
            i.severity == "error" for i in self.issues
        )


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1].replace("-", "_").lower()


def _xml_row(node: Any) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for child in list(node):
        key = _local(child.tag)
        value = (child.text or "").strip()
        # Google XML commonly appends a currency code to <price>.
        if key == "availability" and value:
            row[key] = value
        elif key in {
            "id",
            "title",
            "description",
            "link",
            "image_link",
            "price",
            "currency",
            "availability",
            "brand",
            "gtin",
            "mpn",
            "product_type",
            "google_product_category",
            "condition",
            "identifier_exists",
        }:
            row[key] = value
    return row


class ProductFeedManager:
    """Parse JSON or Google Merchant RSS/XML and report actionable validation issues."""

    MAX_BYTES = 10 * 1024 * 1024
    MAX_PRODUCTS = 50_000

    def parse(
        self, payload: bytes | str, content_type: str | None = None
    ) -> FeedReport:
        raw = payload.encode("utf-8") if isinstance(payload, str) else payload
        if not raw or len(raw) > self.MAX_BYTES:
            return FeedReport(
                products=[],
                issues=[
                    FeedIssue(
                        severity="error",
                        code="FEED_SIZE_INVALID",
                        message="Feed must be non-empty and no larger than 10 MiB",
                    )
                ],
                rejected_rows=1,
                source_format="unknown",
            )
        stripped = raw.lstrip()
        try:
            if (content_type and "json" in content_type.lower()) or stripped[:1] in (
                b"{",
                b"[",
            ):
                return self._parse_json(raw)
            return self._parse_xml(raw)
        except Exception as exc:
            # Avoid returning parser internals or any untrusted feed content to clients.
            return FeedReport(
                products=[],
                issues=[
                    FeedIssue(
                        severity="error",
                        code="FEED_PARSE_ERROR",
                        message=type(exc).__name__,
                    )
                ],
                rejected_rows=1,
                source_format="xml-or-json",
            )

    def _parse_json(self, raw: bytes) -> FeedReport:
        decoded = json.loads(raw)
        rows = (
            decoded
            if isinstance(decoded, list)
            else decoded.get("products", decoded.get("items", []))
            if isinstance(decoded, dict)
            else None
        )
        if not isinstance(rows, list) or len(rows) > self.MAX_PRODUCTS:
            raise ValueError("invalid product collection")
        return self._validate_rows([self._normalize_row(row) for row in rows], "json")

    @staticmethod
    def _normalize_row(row: Any) -> Any:
        if not isinstance(row, dict):
            return row
        aliases = {
            "imageLink": "image_link",
            "productType": "product_type",
            "googleProductCategory": "google_product_category",
            "identifierExists": "identifier_exists",
            "g:id": "id",
            "g:title": "title",
            "g:description": "description",
            "g:link": "link",
            "g:image_link": "image_link",
            "g:price": "price",
            "g:availability": "availability",
            "g:brand": "brand",
            "g:gtin": "gtin",
            "g:mpn": "mpn",
            "g:condition": "condition",
            "g:product_type": "product_type",
            "g:google_product_category": "google_product_category",
        }
        return {aliases.get(str(key), str(key)): value for key, value in row.items()}

    def _parse_xml(self, raw: bytes) -> FeedReport:
        root = SafeET.fromstring(raw)
        nodes = [
            node for node in root.iter() if _local(node.tag) in {"item", "product"}
        ]
        if len(nodes) > self.MAX_PRODUCTS:
            raise ValueError("product limit exceeded")
        return self._validate_rows([_xml_row(node) for node in nodes], "xml")

    def _validate_rows(self, rows: list[Any], source_format: str) -> FeedReport:
        products: list[FeedProduct] = []
        issues: list[FeedIssue] = []
        rejected = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                rejected += 1
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="ROW_NOT_OBJECT",
                        message=f"Row {index + 1} is not an object",
                    )
                )
                continue
            try:
                product = FeedProduct.model_validate(row)
            except Exception as exc:
                rejected += 1
                # Pydantic errors contain only field/type details, never echo feed values.
                fields = ", ".join(
                    str(e.get("loc", ["?"])[0])
                    for e in getattr(exc, "errors", lambda: [])()
                )
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="PRODUCT_INVALID",
                        product_id=str(row.get("id") or "") or None,
                        field=fields or None,
                        message=f"Product row {index + 1} failed schema validation",
                    )
                )
                continue
            products.append(product)
            if not product.description.strip():
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="DESCRIPTION_MISSING",
                        product_id=product.id,
                        field="description",
                        message="A product description is required before channel submission",
                    )
                )
            if not product.image_link:
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="IMAGE_MISSING",
                        product_id=product.id,
                        field="image_link",
                        message="A public product image is required before channel submission",
                    )
                )
            if not product.product_type and not product.google_product_category:
                issues.append(
                    FeedIssue(
                        severity="warning",
                        code="CATEGORY_MISSING",
                        product_id=product.id,
                        field="product_type",
                        message="Add a product category to improve channel matching and feed diagnostics",
                    )
                )
            if not product.gtin and product.identifier_exists is not False:
                issues.append(
                    FeedIssue(
                        severity="warning",
                        code="GTIN_MISSING",
                        product_id=product.id,
                        field="gtin",
                        message="GTIN is missing; verify identifier exemption or the brand/MPN fallback before Google submission",
                    )
                )
            if product.currency != "EUR":
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="CURRENCY_UNSUPPORTED",
                        product_id=product.id,
                        field="currency",
                        message="Homestro ad feeds are configured for EUR",
                    )
                )
            if product.availability not in {
                "in_stock",
                "out_of_stock",
                "preorder",
                "backorder",
            }:
                issues.append(
                    FeedIssue(
                        severity="error",
                        code="AVAILABILITY_INVALID",
                        product_id=product.id,
                        field="availability",
                        message="Availability must use a supported Merchant Center value",
                    )
                )
        if not rows:
            issues.append(
                FeedIssue(
                    severity="error",
                    code="FEED_EMPTY",
                    message="No product rows were found",
                )
            )
        return FeedReport(
            products=products,
            issues=issues,
            rejected_rows=rejected,
            source_format=source_format,
        )

    def prepare_channels(self, report: FeedReport) -> dict[str, list[dict[str, Any]]]:
        """Normalize approved feed rows into provider-neutral channel payloads; never uploads."""
        blockers = {
            issue.product_id
            for issue in report.issues
            if issue.severity == "error" and issue.product_id
        }
        output: dict[str, list[dict[str, Any]]] = {
            channel.value: [] for channel in Channel
        }
        for product in report.products:
            if product.id in blockers or product.availability == "out_of_stock":
                continue
            base = {
                "id": product.id,
                "title": product.title,
                "description": product.description,
                "url": product.link,
                "image_url": product.image_link,
                "price": str(product.price),
                "currency": product.currency,
                "availability": product.availability,
                "brand": product.brand,
                "gtin": product.gtin,
                "mpn": product.mpn,
                "product_type": product.product_type,
            }
            for channel in Channel:
                if channel == Channel.GOOGLE and not (
                    product.gtin
                    or product.identifier_exists is False
                    or (product.brand and product.mpn)
                ):
                    continue
                output[channel.value].append(base.copy())
        return output
