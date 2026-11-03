"""Read-only catalog URL tracking inspection tasks for the staging worker.

This module intentionally has no Meta API client and performs no remote writes.
The caller supplies data already obtained through a read-only feed or catalog
settings readback. Raw URLs and tag values are never returned or logged.
"""

from collections import Counter
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from celery_app import app

MAX_FEED_ITEMS = 5000
MAX_VALUE_LENGTH = 8192
TRACKING_KEYS = {"fbclid", "gclid", "msclkid", "pilot_ref"}


def _parse_tag_names(value: Any) -> list[str]:
    """Return query parameter names only; never retain parameter values."""
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
        return [name.casefold() for name, _ in parse_qsl(query, keep_blank_values=False)
                if name and len(name) <= 100]
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
    source = []
    if rows:
        source.append("product_feed_snapshot")
    if isinstance(catalog_settings, dict):
        source.append("catalog_settings_readback")

    if not source:
        status = "blocked"
        reason = "READ_ONLY_FEED_OR_CATALOG_READBACK_REQUIRED"
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
        "meta_api_called": False,
        "writes_performed": False,
        "attribution_verified": False,
    }
