"""Deterministic German copy safeguards for the organic marketing pipeline."""
from __future__ import annotations

import re
import unicodedata
from typing import Any

_PET = re.compile(r"\b(?:hund|hunde|katze|katzen|haustier|pet|dog|cat)\b", re.I)
_EAR = re.compile(r"\b(?:ohr|ohren|ohrpflege|ohrmilben|ear)\b", re.I)
_MEDICAL_OR_MITE = re.compile(
    r"\b(?:milben?|ohrmilben|mites?|behand(?:el|lung|elt)|therap(?:ie|ieren)|"
    r"heilt?|heilung|entzünd(?:ung|ungen)|infektion(?:en)?|schmerz(?:en)?|"
    r"medizinisch(?:es|e|er)?|antiparasit(?:är|aer)?|parasitenbekämpfung|"
    r"lindert?|wirkt\s+gegen|stoppt)\b", re.I,
)
_LANGUAGE_CLAIM = re.compile(r"\b135\s*(?:sprachen|languages|langues)\b", re.I)
_HASHTAG = re.compile(r"#[\wäöüß]+", re.I)


def product_text(product: dict[str, Any] | None) -> str:
    product = product or {}
    values = [product.get(key) for key in (
        "title", "product_type", "productType", "description", "descriptionHtml",
        "specifications", "specs", "product_specs", "tags", "options", "variants",
    )]
    return " ".join(str(value or "") for value in values)


def is_pet_product(product: dict[str, Any] | None) -> bool:
    return bool(_PET.search(product_text(product)))


def is_ear_product(product: dict[str, Any] | None) -> bool:
    return bool(_EAR.search(product_text(product)))


def supports_135_languages(product: dict[str, Any] | None) -> bool:
    """Require an explicit count in source specifications or product facts."""
    return bool(_LANGUAGE_CLAIM.search(product_text(product)))


def sanitize_text(
    text: str,
    *,
    product: dict[str, Any] | None = None,
    allow_135_languages: bool | None = None,
) -> str:
    """Drop unsupported claims sentence by sentence and retain safe pet-ear wording."""
    if not isinstance(text, str) or not text:
        return text
    pet = is_pet_product(product)
    ear = pet and (is_ear_product(product) or bool(_EAR.search(text)))
    allow_languages = supports_135_languages(product) if allow_135_languages is None else allow_135_languages
    safe: list[str] = []
    inserted_ear_phrase = False
    for part in re.split(r"(?<=[.!?])\s+|\n+", text):
        sentence = part.strip()
        if not sentence:
            continue
        if not allow_languages and _LANGUAGE_CLAIM.search(sentence):
            continue
        if pet and _MEDICAL_OR_MITE.search(sentence):
            if ear and not inserted_ear_phrase:
                safe.append("sanfte äußere Ohrpflege.")
                inserted_ear_phrase = True
            continue
        safe.append(sentence)
    cleaned = " ".join(safe)
    seen: set[str] = set()

    def keep_unique(match: re.Match[str]) -> str:
        tag = match.group(0)
        key = _hashtag_key(tag)
        if not key or key in seen:
            return ""
        seen.add(key)
        return "#zuhausegefuehl" if key == "zuhausegefuehl" else tag

    cleaned = _HASHTAG.sub(keep_unique, cleaned)
    cleaned = re.sub(r"[ \t]+([,.;!?])", r"\1", cleaned)
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()


def _hashtag_key(tag: str) -> str:
    transliterated = tag.casefold().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    decomposed = unicodedata.normalize("NFKD", transliterated)
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9_]", "", plain.lstrip("#"))


def normalize_hashtags(values: list[str] | str) -> list[str]:
    """Normalize accent variants and remove repeated hashtags in stable order."""
    source = [values] if isinstance(values, str) else list(values or [])
    tags: list[str] = []
    for item in source:
        matches = _HASHTAG.findall(str(item or ""))
        candidates = matches or ([str(item).strip()] if str(item or "").strip().startswith("#") else [])
        for tag in candidates:
            key = _hashtag_key(tag)
            if not key or any(_hashtag_key(existing) == key for existing in tags):
                continue
            tags.append("#zuhausegefuehl" if key == "zuhausegefuehl" else tag)
    return tags


def sanitize_draft(draft: dict[str, Any], product: dict[str, Any] | None = None) -> dict[str, Any]:
    """Copy and sanitize every human-facing string while preserving IDs and links."""
    def visit(value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {child_key: visit(child, child_key) for child_key, child in value.items()}
        if isinstance(value, list):
            if key == "hashtags":
                return normalize_hashtags(value)
            return [visit(child, key) for child in value]
        if isinstance(value, str) and key not in {"product_url", "source_url", "canonical_suggestion", "url", "destination"}:
            return sanitize_text(value, product=product)
        return value

    return visit(draft)
