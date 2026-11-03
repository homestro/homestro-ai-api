"""Read-only catalog URL tracking inspection tasks for the staging worker.

This module intentionally has no Meta API client and performs no remote writes.
The caller supplies data already obtained through a read-only feed or catalog
settings readback. Raw URLs and tag values are never returned or logged.
"""

from collections import Counter
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from celery_app import app

MAX_FEED_ITEMS = 5000
MAX_VALUE_LENGTH = 8192
TRACKING_KEYS = {"fbclid", "gclid", "msclkid", "pilot_ref"}
META_UTM = {
    "utm_source": "meta_pilot",
    "utm_medium": "cpc",
    "utm_campaign": "homestro_catalog",
}
SHOPIFY_PRODUCT_HOST = "homestro.de"


def _parse_tag_names(value: Any) -> list[str]:
    """Return query parameter names only; never retain parameter values."""
    return [name for name, _ in _parse_tag_pairs(value)]


def _parse_tag_pairs(value: Any) -> list[tuple[str, str]]:
    """Parse a URL or query string into bounded pairs for exact readback checks."""
    if not isinstance(value, str) or not value.strip():
        return []
    value = value.strip()[:MAX_VALUE_LENGTH]
    query = value
    if "://" in value:
        try:
            query = urlsplit(value).query
        except ValueError:
            return []
    elif "?" in value:
        query = value.split("?", 1)[1].split("#", 1)[0]
    elif value.startswith("#"):
        return []

    try:
        return [
            (name.casefold(), val[:MAX_VALUE_LENGTH])
            for name, val in parse_qsl(query, keep_blank_values=False)
            if name and len(name) <= 100
        ]
    except ValueError:
        return []


def _tracking_names(names: list[str]) -> list[str]:
    return [name for name in names if name.startswith("utm_") or name in TRACKING_KEYS]


def _catalog_setting_names(catalog_settings: Any) -> list[str]:
    if not isinstance(catalog_settings, dict):
        return []
    # The caller passes the exact, read-only catalog setting readback. No API
    # field is guessed or requested by this task.
    value = catalog_settings.get("url_tags")
    return _parse_tag_names(value)


def _catalog_setting_matches_expected(catalog_settings: Any) -> bool:
    if not isinstance(catalog_settings, dict):
        return False
    pairs = _parse_tag_pairs(catalog_settings.get("url_tags"))
    # Require exactly one of each generated value. Duplicate or conflicting
    # UTM keys make attribution ambiguous, even if the expected value is present.
    return all(
        [value for name, value in pairs if name == expected_name] == [expected_value]
        for expected_name, expected_value in META_UTM.items()
    )


def _meta_product_url(value: Any) -> str | None:
    """Build a Meta-only product URL without mutating the source feed row."""
    if not isinstance(value, str) or not value or len(value) > MAX_VALUE_LENGTH:
        return None
    try:
        parts = urlsplit(value)
        if (
            parts.scheme.casefold() != "https"
            or (parts.hostname or "").casefold() != SHOPIFY_PRODUCT_HOST
            or parts.username is not None
            or parts.password is not None
            or parts.port is not None
            or not parts.path.startswith("/products/")
            or parts.fragment
        ):
            return None
        existing = parse_qsl(parts.query, keep_blank_values=True)
    except ValueError:
        return None

    # Strip stale channel attribution and click IDs, but preserve commerce
    # parameters such as Shopify's `variant` selection.
    kept = [
        (key, val)
        for key, val in existing
        if not key.casefold().startswith("utm_")
        and key.casefold() not in TRACKING_KEYS
    ]
    kept.extend(META_UTM.items())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), ""))


def _prepare_meta_feed(feed_items: Any) -> dict[str, Any]:
    """Create a Meta feed projection; the supplied Shopify rows stay untouched."""
    if not isinstance(feed_items, list) or not feed_items:
        return {
            "status": "blocked",
            "reason": "SHOPIFY_FEED_ITEMS_REQUIRED",
            "meta_feed_items": [],
            "feed_items_seen": 0,
            "feed_items_tagged": 0,
            "feed_items_rejected": 0,
        }

    rows = feed_items[:MAX_FEED_ITEMS]
    output: list[dict[str, Any]] = []
    rejected = 0
    for row in rows:
        if not isinstance(row, dict):
            rejected += 1
            continue
        link_field = next(
            (field for field in ("link", "url", "product_url") if isinstance(row.get(field), str)),
            None,
        )
        tagged_url = _meta_product_url(row.get(link_field)) if link_field else None
        if not tagged_url:
            rejected += 1
            continue
        prepared = dict(row)
        prepared[link_field] = tagged_url
        output.append(prepared)

    total_rejected = rejected + max(0, len(feed_items) - MAX_FEED_ITEMS)
    return {
        "status": "prepared" if output and not total_rejected else "partial" if output else "blocked",
        "reason": None if output and not total_rejected else "INVALID_OR_NON_PRODUCT_URLS_SKIPPED",
        "meta_feed_items": output,
        "feed_items_seen": len(rows),
        "feed_items_tagged": len(output),
        "feed_items_rejected": total_rejected,
        "utm_parameters": META_UTM,
        "shopify_source_feed_written": False,
        "meta_api_called": False,
        "writes_performed": False,
        "pilot_attribution_verified": False,
    }


@app.task(
    bind=True,
    name="media_buyer.prepare_meta_catalog_feed",
    acks_late=True,
    max_retries=0,
)
def prepare_meta_catalog_feed(
    self,
    feed_items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Prepare a Meta-specific tagged copy of the current Shopify feed rows.

    The tagged output is for the Meta catalog feed adapter. It is not written
    back to Shopify or to an ad, and must be read back from the catalog before
    the pilot can claim that Meta is using these destinations.
    """
    return {
        "task": "media_buyer.prepare_meta_catalog_feed",
        **_prepare_meta_feed(feed_items),
    }


@app.task(
    bind=True,
    name="media_buyer.inspect_catalog_url_tags",
    acks_late=True,
    max_retries=0,
)
def inspect_catalog_url_tags(
    self,
    feed_items: list[dict[str, Any]] | None = None,
    catalog_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Summarize tracking keys read from a feed snapshot or catalog readback.

    ``feed_items`` should contain rows from the existing read-only feed reader;
    this task inspects each row's ``url_tags`` field and/or ``link``, ``url`` or
    ``product_url``. ``catalog_settings`` should be the exact result of a
    supported read-only catalog settings query and may contain ``url_tags``.
    """
    rows = feed_items if isinstance(feed_items, list) else []
    rows = rows[:MAX_FEED_ITEMS]
    feed_counts: Counter[str] = Counter()
    checked_rows = 0
    tagged_rows = 0

    for row in rows:
        if not isinstance(row, dict):
            continue
        checked_rows += 1
        row_names: set[str] = set()
        for field in ("url_tags", "link", "url", "product_url"):
            row_names.update(_parse_tag_names(row.get(field)))
        tracking = set(_tracking_names(list(row_names)))
        feed_counts.update(tracking)
        if tracking:
            tagged_rows += 1

    setting_names = _tracking_names(_catalog_setting_names(catalog_settings))
    setting_matches = _catalog_setting_matches_expected(catalog_settings)
    source = []
    if rows:
        source.append("product_feed_snapshot")
    if isinstance(catalog_settings, dict):
        source.append("catalog_settings_readback")

    if not source:
        status = "blocked"
        reason = "READ_ONLY_FEED_OR_CATALOG_READBACK_REQUIRED"
    elif isinstance(catalog_settings, dict) and setting_names and not setting_matches:
        status = "mismatch"
        reason = "CATALOG_URL_TAGS_DO_NOT_MATCH_META_UTM_CONFIGURATION"
    elif feed_counts or setting_names:
        status = "readback_confirmed"
        reason = None
    else:
        status = "no_tracking_parameters_found"
        reason = "NO_URL_TRACKING_PARAMETERS_IN_READBACK"

    return {
        "task": "media_buyer.inspect_catalog_url_tags",
        "status": status,
        "reason": reason,
        "sources": source,
        "feed_items_checked": checked_rows,
        "feed_items_with_tracking_parameters": tagged_rows,
        "feed_tracking_parameter_names": sorted(feed_counts),
        "feed_parameter_occurrences": dict(sorted(feed_counts.items())),
        "catalog_setting_present": bool(setting_names),
        "catalog_setting_parameter_names": sorted(set(setting_names)),
        "catalog_setting_matches_expected_utm": setting_matches,
        "meta_catalog_url_tags_readback_confirmed": setting_matches,
        "meta_api_called": False,
        "writes_performed": False,
        "pilot_attribution_verified": False,
    }
