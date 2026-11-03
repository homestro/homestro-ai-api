"""Build one factual product landing-page artifact and notify search tools.

This task does not create city-doorway variants, publish a page, or call
Google's restricted Indexing API. It builds one HTML artifact per product.
Search notifications are accepted only after a publisher makes the page and
sitemap publicly reachable.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

import redis
from celery import chain

from celery_app import app

MAX_TITLE_CHARS = 300
MAX_TEXT_CHARS = 6000
MAX_HTML_BYTES = 2_000_000
GOOGLE_WEBMASTERS_SCOPE = "https://www.googleapis.com/auth/webmasters"
GOOGLE_SITEMAPS_API = "https://www.googleapis.com/webmasters/v3/sites/{site}/sitemaps/{feed}"
INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow"
BING_SUBMIT_URL_ENDPOINT = "https://www.bing.com/webmaster/api.svc/json/SubmitUrl"


class _CanonicalParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.canonical: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "link":
            return
        values = {key.casefold(): value for key, value in attrs}
        if (values.get("rel") or "").casefold() == "canonical":
            self.canonical = values.get("href")


def _bounded_string(data: Any, name: str, limit: int, required: bool = False) -> str:
    if data is None and not required:
        return ""
    if not isinstance(data, str):
        raise ValueError(f"{name} must be a string.")
    value = data.strip()
    if required and not value:
        raise ValueError(f"{name} is required.")
    if len(value) > limit:
        raise ValueError(f"{name} exceeds {limit} characters.")
    return value


def _allowed_homestro_url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Expected an HTTPS Homestro URL.")
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").casefold()
        if (
            parts.scheme.casefold() != "https"
            or not (host == "homestro.de" or host.endswith(".homestro.de"))
            or parts.username is not None
            or parts.password is not None
            or parts.port is not None
            or parts.query
            or parts.fragment
        ):
            raise ValueError
    except ValueError:
        raise ValueError("URL must use HTTPS on homestro.de without credentials or query strings.") from None
    return value.rstrip("/")


def _image_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").casefold()
        allowed = host == "cdn.shopify.com" or host.endswith(".shopifycdn.net")
        if parts.scheme.casefold() == "https" and allowed and not parts.username and not parts.password:
            return value
    except ValueError:
        return None
    return None


def _clean_product(product: Any) -> dict[str, Any]:
    if not isinstance(product, dict):
        raise ValueError("product must be a JSON object.")
    product_id = _bounded_string(product.get("product_id"), "product.product_id", 200, True)
    title = _bounded_string(product.get("title"), "product.title", MAX_TITLE_CHARS, True)
    description = _bounded_string(product.get("description"), "product.description", MAX_TEXT_CHARS)
    handle = _bounded_string(product.get("handle"), "product.handle", 200, True)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", handle):
        raise ValueError("product.handle contains unsupported characters.")
    product_url = _allowed_homestro_url(product.get("product_url"))
    image = _image_url(product.get("image_url"))

    price: float | None = None
    try:
        if product.get("price") is not None:
            price = float(product["price"])
            if price <= 0:
                price = None
    except (TypeError, ValueError):
        price = None
    currency = _bounded_string(product.get("currency"), "product.currency", 3)
    if currency and not re.fullmatch(r"[A-Z]{3}", currency):
        currency = ""

    return {
        "product_id": product_id,
        "title": title,
        "description": description,
        "handle": handle,
        "product_url": product_url,
        "image_url": image,
        "price": price,
        "currency": currency,
    }


def _validate_creative_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict) or result.get("status") != "generated":
        raise ValueError("A successful creative task result is required.")
    creative = result.get("creative")
    if not isinstance(creative, dict):
        raise ValueError("creative result is missing.")
    headline = _bounded_string(creative.get("headline"), "creative.headline", 300, True)
    nugget = _bounded_string(creative.get("golden_nugget"), "creative.golden_nugget", 1000, True)
    raw_bullets = creative.get("bullets")
    raw_faq = creative.get("faq")
    if not isinstance(raw_bullets, list) or len(raw_bullets) != 3:
        raise ValueError("creative must contain exactly three bullet points.")
    if not isinstance(raw_faq, list) or len(raw_faq) != 3:
        raise ValueError("creative must contain exactly three FAQ pairs.")
    bullets = [_bounded_string(item, "creative bullet", 500, True) for item in raw_bullets]
    faq = []
    for item in raw_faq:
        if not isinstance(item, dict):
            raise ValueError("FAQ entries must be objects.")
        faq.append(
            {
                "question": _bounded_string(item.get("question"), "FAQ question", 300, True),
                "answer": _bounded_string(item.get("answer"), "FAQ answer", 1000, True),
            }
        )
    return {"headline": headline, "golden_nugget": nugget, "bullets": bullets, "faq": faq}


def _json_ld(product: dict[str, Any], creative: dict[str, Any], page_url: str) -> str:
    schema: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": product["title"],
        "description": product["description"] or creative["golden_nugget"],
        "url": page_url,
    }
    if product["image_url"]:
        schema["image"] = [product["image_url"]]
    if product["price"] is not None and product["currency"]:
        schema["offers"] = {
            "@type": "Offer",
            "url": product["product_url"],
            "priceCurrency": product["currency"],
            "price": f"{product['price']:.2f}",
            "availability": "https://schema.org/InStock",
        }
    # Escape '<' so supplied product text cannot terminate the JSON-LD script.
    return json.dumps(schema, ensure_ascii=False).replace("<", "\\u003c")


def _render_html(product: dict[str, Any], creative: dict[str, Any], page_url: str) -> str:
    title = html.escape(creative["headline"])
    product_title = html.escape(product["title"])
    description = html.escape(creative["golden_nugget"])
    bullets = "\n".join(f"<li>{html.escape(item)}</li>" for item in creative["bullets"])
    faq = "\n".join(
        "<details><summary>"
        + html.escape(item["question"])
        + "</summary><p>"
        + html.escape(item["answer"])
        + "</p></details>"
        for item in creative["faq"]
    )
    image_html = ""
    if product["image_url"]:
        image_html = (
            f'<img src="{html.escape(product["image_url"], quote=True)}" '
            f'alt="{product_title}" loading="eager" width="1200" height="1200">'
        )
    details = html.escape(product["description"])
    body_copy = f"<p>{details}</p>" if details else ""
    json_ld = _json_ld(product, creative, page_url)
    return f"""<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} | Homestro</title>
  <meta name="description" content="{description[:300]}">
  <link rel="canonical" href="{html.escape(page_url, quote=True)}">
  <meta property="og:type" content="product">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{description[:300]}">
  <meta property="og:url" content="{html.escape(page_url, quote=True)}">
  <script type="application/ld+json">{json_ld}</script>
</head>
<body>
  <main>
    {image_html}
    <h1>{title}</h1>
    <p>{description}</p>
    <h2>{product_title}</h2>
    {body_copy}
    <ul>{bullets}</ul>
    <section aria-labelledby="faq-heading"><h2 id="faq-heading">Häufige Fragen</h2>{faq}</section>
    <p><a href="{html.escape(product['product_url'], quote=True)}" rel="nofollow">Zum Produkt bei Homestro</a></p>
  </main>
</body>
</html>"""


def _assert_public_page(url: str, expected_host: str) -> bytes:
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").casefold() != expected_host:
        raise ValueError("Published URL must use the configured Homestro host.")
    request = Request(url, headers={"User-Agent": "HomestroPilot-SEO/1.0"}, method="GET")
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError(f"Public page returned HTTP {response.status}.")
            body = response.read(MAX_HTML_BYTES + 1)
    except HTTPError as exc:
        raise RuntimeError(f"Public page returned HTTP {exc.code}.") from None
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"Could not verify public page ({type(exc).__name__}).") from None
    if len(body) > MAX_HTML_BYTES:
        raise RuntimeError("Public page is larger than the verification limit.")
    parser = _CanonicalParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    if parser.canonical != url:
        raise RuntimeError("Published page canonical does not match the submitted URL.")
    return body


def _assert_public_sitemap(sitemap_url: str, expected_host: str, page_url: str) -> None:
    parts = urlsplit(sitemap_url)
    if parts.scheme != "https" or (parts.hostname or "").casefold() != expected_host:
        raise ValueError("Sitemap must use the configured Homestro host.")
    request = Request(sitemap_url, headers={"User-Agent": "HomestroPilot-SEO/1.0"}, method="GET")
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError(f"Sitemap returned HTTP {response.status}.")
            sitemap = response.read(MAX_HTML_BYTES + 1).decode("utf-8", errors="replace")
    except HTTPError as exc:
        raise RuntimeError(f"Sitemap returned HTTP {exc.code}.") from None
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"Could not verify sitemap ({type(exc).__name__}).") from None
    if len(sitemap) > MAX_HTML_BYTES or page_url not in sitemap:
        raise RuntimeError("Sitemap is oversized or does not contain the published page URL.")


def _redis() -> redis.Redis:
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL is required for SEO idempotency.")
    return redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=5)


@app.task(
    bind=True,
    name="seo_geo.build_product_landing_page",
    acks_late=False,
    max_retries=0,
)
def build_product_landing_page(
    self,
    creative_result: dict[str, Any],
    product: dict[str, Any],
) -> dict[str, Any]:
    """Build one German HTML page from verified product facts and creative copy."""
    public_base = os.getenv("SEO_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not public_base:
        return {
            "task": "seo_geo.build_product_landing_page",
            "status": "blocked",
            "reason": "SEO_PUBLIC_BASE_URL and a static publisher are not configured",
            "page_published": False,
            "search_engines_notified": False,
        }
    public_base = _allowed_homestro_url(public_base)
    clean_product = _clean_product(product)
    clean_creative = _validate_creative_result(creative_result)
    page_url = f"{public_base}/p/{clean_product['handle']}/"
    html_document = _render_html(clean_product, clean_creative, page_url)
    if len(html_document.encode("utf-8")) > MAX_HTML_BYTES:
        raise ValueError("Generated HTML exceeds the page size limit.")

    digest = hashlib.sha256(
        (clean_product["product_id"] + page_url + html_document).encode("utf-8")
    ).hexdigest()
    cache_key = f"pilot_staging:seo_geo:page:{digest}"
    if not _redis().set(cache_key, "built", nx=True, ex=180 * 24 * 60 * 60):
        return {
            "task": "seo_geo.build_product_landing_page",
            "status": "already_built",
            "product_id": clean_product["product_id"],
            "page_url": page_url,
            "content_sha256": digest,
            "page_published": False,
            "search_engines_notified": False,
        }
    return {
        "task": "seo_geo.build_product_landing_page",
        "status": "ready_to_publish",
        "product_id": clean_product["product_id"],
        "product": clean_product,
        "creative": clean_creative,
        "page_url": page_url,
        "canonical_url": page_url,
        "content_sha256": digest,
        "html": html_document,
        "sitemap_entry": {
            "loc": page_url,
            "lastmod": datetime.now(timezone.utc).date().isoformat(),
        },
        "page_published": False,
        "search_engines_notified": False,
        "city_variants_created": 0,
        "product_created": False,
        "image_generated": False,
    }


@app.task(
    bind=True,
    name="seo_geo.notify_search_engines_after_publish",
    acks_late=False,
    max_retries=0,
)
def notify_search_engines_after_publish(
    self,
    published_url: str,
    sitemap_url: str,
) -> dict[str, Any]:
    """Notify Search Console and IndexNow only after public HTTP 200 readback."""
    public_base = os.getenv("SEO_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not public_base:
        return {"status": "blocked", "reason": "SEO_PUBLIC_BASE_URL is not configured"}
    public_host = (urlsplit(_allowed_homestro_url(public_base)).hostname or "").casefold()
    published_url = _allowed_homestro_url(published_url)
    sitemap_url = _allowed_homestro_url(sitemap_url)
    _assert_public_page(published_url, public_host)
    _assert_public_sitemap(sitemap_url, public_host, published_url)

    outcomes: dict[str, Any] = {
        "task": "seo_geo.notify_search_engines_after_publish",
        "status": "submitted",
        "public_page_http_status": 200,
        "sitemap_http_status": 200,
        "google": "not_configured",
        "bing_webmaster": "not_configured",
        "indexnow": "not_configured",
        "google_indexing_api_called": False,
        "indexing_guaranteed": False,
    }

    # Google supports sitemap submission for ordinary product pages. Its
    # Indexing API is intentionally not used for products or generated landers.
    google_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    google_property = os.getenv("GOOGLE_SEARCH_CONSOLE_PROPERTY")
    if google_json and google_property:
        try:
            from google.auth.transport.requests import AuthorizedSession
            from google.oauth2 import service_account

            credentials_info = json.loads(google_json)
            credentials = service_account.Credentials.from_service_account_info(
                credentials_info,
                scopes=[GOOGLE_WEBMASTERS_SCOPE],
            )
            session = AuthorizedSession(credentials)
            endpoint = GOOGLE_SITEMAPS_API.format(
                site=quote(google_property, safe=""),
                feed=quote(sitemap_url, safe=""),
            )
            response = session.put(endpoint, timeout=20)
            outcomes["google"] = "sitemap_submitted" if response.status_code in {200, 204} else f"http_{response.status_code}"
        except Exception as exc:
            outcomes["google"] = f"error_{type(exc).__name__}"

    bing_api_key = os.getenv("BING_WEBMASTER_API_KEY", "").strip()
    bing_site_url = os.getenv("BING_WEBMASTER_SITE_URL", public_base).strip().rstrip("/")
    if bing_api_key and bing_site_url:
        try:
            # Bing's JSON SubmitUrl endpoint uses the webmaster API key as a
            # query parameter. Never include the request URL in task output.
            bing_site_url = _allowed_homestro_url(bing_site_url)
            endpoint = BING_SUBMIT_URL_ENDPOINT + "?" + urlencode({"apikey": bing_api_key})
            payload = json.dumps(
                {"siteUrl": bing_site_url, "url": published_url}
            ).encode("utf-8")
            request = Request(
                endpoint,
                data=payload,
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST",
            )
            with urlopen(request, timeout=20) as response:
                outcomes["bing_webmaster"] = (
                    f"accepted_http_{response.status}"
                    if response.status == 200
                    else f"http_{response.status}"
                )
        except HTTPError as exc:
            outcomes["bing_webmaster"] = f"http_{exc.code}"
        except Exception as exc:
            outcomes["bing_webmaster"] = f"error_{type(exc).__name__}"

    indexnow_key = os.getenv("INDEXNOW_KEY", "").strip()
    key_location = os.getenv("INDEXNOW_KEY_LOCATION", "").strip()
    if indexnow_key and key_location:
        key_parts = urlsplit(key_location)
        if key_parts.scheme != "https" or (key_parts.hostname or "").casefold() != public_host:
            outcomes["indexnow"] = "blocked_key_file_host_mismatch"
        else:
            try:
                key_request = Request(key_location, headers={"User-Agent": "HomestroPilot-SEO/1.0"})
                with urlopen(key_request, timeout=15) as response:
                    served_key = response.read(512).decode("utf-8", errors="replace").strip()
                if served_key != indexnow_key:
                    outcomes["indexnow"] = "blocked_key_file_mismatch"
                else:
                    payload = json.dumps(
                        {
                            "host": public_host,
                            "key": indexnow_key,
                            "keyLocation": key_location,
                            "urlList": [published_url],
                        }
                    ).encode("utf-8")
                    request = Request(
                        INDEXNOW_ENDPOINT,
                        data=payload,
                        headers={"Content-Type": "application/json; charset=utf-8"},
                        method="POST",
                    )
                    with urlopen(request, timeout=20) as response:
                        outcomes["indexnow"] = f"accepted_http_{response.status}"
            except HTTPError as exc:
                outcomes["indexnow"] = f"http_{exc.code}"
            except Exception as exc:
                outcomes["indexnow"] = f"error_{type(exc).__name__}"

    return outcomes


@app.task(
    bind=True,
    name="seo_geo.enqueue_creative_to_page_chain",
    acks_late=False,
    max_retries=0,
)
def enqueue_creative_to_page_chain(self, product: dict[str, Any]) -> dict[str, Any]:
    """Start creative generation, then build exactly one HTML page artifact."""
    if os.getenv("SEO_WORKFLOW_ENABLED", "false").casefold() not in {"1", "true", "yes", "on"}:
        return {"status": "paused", "reason": "SEO_WORKFLOW_ENABLED is not true"}
    if os.getenv("SEO_PUBLISHER_READY", "false").casefold() not in {"1", "true", "yes", "on"}:
        return {
            "status": "blocked",
            "reason": "SEO_PUBLISHER_READY is not true; no public HTML publisher is configured",
            "creative_task_queued": False,
        }
    if not os.getenv("SEO_PUBLIC_BASE_URL"):
        return {"status": "blocked", "reason": "SEO_PUBLIC_BASE_URL is not configured"}
    from agents.kreativni_agent import generate_creative
    from agents.media_buying_agent.tasks import prepare_catalog_ad_creative

    workflow = chain(
        generate_creative.s(product),
        build_product_landing_page.s(product=product),
        prepare_catalog_ad_creative.s(),
    )
    result = workflow.apply_async()
    return {
        "status": "queued",
        "workflow_id": result.id,
        "next_task": "seo_geo.build_product_landing_page",
        "then_task": "media_buyer.prepare_catalog_ad_creative",
        "page_published": False,
        "search_engines_notified": False,
    }
