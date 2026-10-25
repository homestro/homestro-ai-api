"""Bounded read-only storefront diagnostics, not a search-ranking prediction."""
from __future__ import annotations

import json
from urllib.parse import urljoin, urlsplit

import httpx
from lxml import html

ALLOWED_HOSTS = {'homestro.de', 'www.homestro.de'}
MAX_HTML = 2 * 1024 * 1024


def allowed(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.hostname in ALLOWED_HOSTS
                and not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


def inspect_page(content, url, *, status_code=200):
    if not allowed(url) or len(content) > MAX_HTML:
        raise ValueError('unapproved or oversized page')
    page = html.fromstring(content, base_url=url, parser=html.HTMLParser(no_network=True))
    issues = []
    title = ' '.join(page.xpath('//title/text()')).strip()
    description = page.xpath('//meta[translate(@name,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="description"]/@content')
    canonical = page.xpath('//link[contains(concat(" ",normalize-space(@rel)," ")," canonical ")]/@href')
    robots = ' '.join(page.xpath('//meta[translate(@name,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="robots"]/@content')).lower()
    h1 = [' '.join(node.itertext()).strip() for node in page.xpath('//h1')]
    if status_code != 200:
        issues.append({'code': 'LANDING_HTTP_NOT_200', 'priority': 'high'})
    if not title:
        issues.append({'code': 'TITLE_MISSING', 'priority': 'high'})
    if not description or not description[0].strip():
        issues.append({'code': 'META_DESCRIPTION_MISSING', 'priority': 'medium'})
    if len(h1) != 1 or not h1[0]:
        issues.append({'code': 'SINGLE_NONEMPTY_H1_REQUIRED', 'priority': 'medium'})
    if not canonical:
        issues.append({'code': 'CANONICAL_MISSING', 'priority': 'medium'})
    elif not allowed(urljoin(url, canonical[0])):
        issues.append({'code': 'CANONICAL_OUTSIDE_STORE', 'priority': 'high'})
    if 'noindex' in robots:
        issues.append({'code': 'PAGE_NOINDEX', 'priority': 'high'})
    images = page.xpath('//img')
    missing_alt = sum(not (image.get('alt') or '').strip() for image in images)
    if missing_alt:
        issues.append({'code': 'IMAGE_ALT_MISSING', 'priority': 'low', 'image_count': missing_alt})
    jsonld_valid, product_schema = False, False
    def has_product(value):
        if isinstance(value, list):
            return any(has_product(item) for item in value)
        if isinstance(value, dict):
            types = value.get('@type', [])
            if isinstance(types, str):
                types = [types]
            return 'Product' in types or has_product(value.get('@graph', []))
        return False
    for raw in page.xpath('//script[@type="application/ld+json"]/text()'):
        try:
            parsed = json.loads(raw)
            jsonld_valid = True
            product_schema = product_schema or has_product(parsed)
        except ValueError:
            issues.append({'code': 'JSON_LD_INVALID', 'priority': 'medium'})
    if '/products/' in urlsplit(url).path and not product_schema:
        issues.append({'code': 'PRODUCT_STRUCTURED_DATA_NOT_FOUND', 'priority': 'medium'})
    return {'url': url, 'http_status': status_code, 'title_present': bool(title), 'h1_count': len(h1),
            'meta_description_present': bool(description and description[0].strip()),
            'canonical_present': bool(canonical), 'json_ld_valid': jsonld_valid,
            'product_structured_data_present': product_schema, 'issues': issues,
            'rankings_verified': False, 'conversion_rate_verified': False,
            'core_web_vitals_measured': False, 'mutations_performed': False}


async def audit_store(products, *, client=None):
    urls = ['https://homestro.de/']
    for product in products:
        url = product.get('link', '')
        if allowed(url) and url not in urls:
            urls.append(url)
        if len(urls) == 4:
            break
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4), follow_redirects=False)
    results = []
    try:
        for initial in urls:
            current = initial
            try:
                for _ in range(3):
                    async with client.stream('GET', current, follow_redirects=False,
                                             headers={'Accept': 'text/html'}) as response:
                        if response.is_redirect:
                            target = urljoin(current, response.headers.get('location', ''))
                            if not allowed(target) or target == current:
                                raise ValueError('unapproved redirect')
                            current = target
                            continue
                        body = bytearray()
                        async for part in response.aiter_bytes():
                            body.extend(part)
                            if len(body) > MAX_HTML:
                                raise ValueError('page too large')
                        results.append(inspect_page(bytes(body), current, status_code=response.status_code))
                        break
                else:
                    raise ValueError('redirect limit')
            except Exception as exc:
                results.append({'url': initial, 'status': 'unavailable', 'error_type': type(exc).__name__,
                                'mutations_performed': False})
        return {'status': 'diagnosed', 'sampled_pages': len(results), 'pages': results,
                'all_store_pages_audited': False, 'mutations_performed': False}
    finally:
        if own:
            await client.aclose()
