"""Signed URL attribution and conservative contribution accounting, without customer PII."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


def money(value):
    number = Decimal(str(value))
    if not number.is_finite() or number < 0:
        raise ValueError('invalid money')
    return number


def instant(value):
    result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone required')
    return result.astimezone(UTC)


CHANNELS = {'meta', 'google', 'microsoft', 'facebook', 'instagram', 'tiktok', 'pinterest'}


def tracking_ref(campaign, ad, experiment, *, secret, expires_at, issued_at=None, channel='meta'):
    if not secret or not all(re.fullmatch(r'\d{4,30}', str(x)) for x in (campaign, ad)):
        raise ValueError('tracking configuration invalid')
    if not re.fullmatch(r'[a-f0-9]{16,64}', experiment):
        raise ValueError('invalid experiment')
    if channel not in CHANNELS:
        raise ValueError('unsupported attribution channel')
    issued_at = issued_at or datetime.now(UTC)
    if not timedelta(0) < instant(expires_at) - instant(issued_at) <= timedelta(days=7):
        raise ValueError('invalid attribution lifetime')
    payload = {'channel': channel, 'campaign': campaign, 'ad': ad, 'experiment': experiment,
               'issued': (issued_at or datetime.now(UTC)).isoformat(), 'expires': expires_at.isoformat()}
    body = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).decode().rstrip('=')
    signature = hmac.new(secret.encode(), ('pilot-attribution-v1:' + body).encode(), hashlib.sha256).hexdigest()
    return body + '.' + signature


def decode_ref(token, *, secret, at):
    if not secret or not isinstance(token, str) or len(token) > 1024:
        return None
    try:
        body, signature = token.split('.')
        expected = hmac.new(secret.encode(), ('pilot-attribution-v1:' + body).encode(), hashlib.sha256).hexdigest()
        if not signature.isascii() or not hmac.compare_digest(signature, expected):
            return None
        data = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
        if not isinstance(data, dict):
            return None
        if (not all(re.fullmatch(r'\d{4,30}', str(data.get(key, ''))) for key in ('campaign', 'ad'))
                or not re.fullmatch(r'[a-f0-9]{16,64}', data.get('experiment', ''))
                or not instant(data['issued']) <= at <= instant(data['expires'])
                or instant(data['expires']) - instant(data['issued']) > timedelta(days=7)):
            return None
        if data.get('channel', 'meta') not in CHANNELS:
            return None
        data.setdefault('channel', 'meta')
        return data
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def tracked_story(story, ref, campaign, ad):
    result = json.loads(json.dumps(story))
    def url(value):
        parsed = urlsplit(value)
        if parsed.scheme != 'https' or parsed.hostname not in {'homestro.de', 'www.homestro.de'}:
            raise ValueError('unapproved tracking destination')
        query = parse_qs(parsed.query, keep_blank_values=True)
        query.update({'utm_source': ['meta'], 'utm_medium': ['paid_social'], 'utm_campaign': [campaign],
                      'utm_content': [ad], 'pilot_ref': [ref]})
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query, doseq=True), parsed.fragment))
    data = result['link_data']
    for item in [data, *data.get('child_attachments', [])]:
        item['link'] = url(item['link'])
        item['call_to_action']['value']['link'] = item['link']
    return result


def tracked_url(value, ref, *, secret, at):
    """One signed channel binding; arbitrary UTM tags alone never establish a sale."""
    data = decode_ref(ref, secret=secret, at=at)
    parsed = urlsplit(value)
    if (not data or parsed.scheme != 'https' or parsed.hostname not in {'homestro.de', 'www.homestro.de'}
            or parsed.username or parsed.password or parsed.port not in {None, 443}):
        raise ValueError('unapproved attribution destination or signature')
    query = parse_qs(parsed.query, keep_blank_values=True)
    medium = 'cpc' if data['channel'] in {'google', 'microsoft'} else ('paid_social' if data['channel'] == 'meta' else 'organic_social')
    query.update({'utm_source': [data['channel']], 'utm_medium': [medium],
                  'utm_campaign': [str(data['campaign'])], 'utm_content': [str(data['ad'])], 'pilot_ref': [ref]})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query, doseq=True), parsed.fragment))


def initialize(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS pilot_unit_costs (
          variant TEXT PRIMARY KEY, amount TEXT NOT NULL, currency TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pilot_order_economics (
          order_hash TEXT PRIMARY KEY, campaign TEXT NOT NULL, ad TEXT NOT NULL, experiment TEXT NOT NULL,
          paid_at TEXT NOT NULL, net_revenue TEXT, cogs TEXT, blocked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS pilot_order_fingerprints (order_hash TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pilot_order_expenses (
          order_hash TEXT PRIMARY KEY, fulfillment TEXT NOT NULL, fees TEXT NOT NULL,
          returns_cost TEXT NOT NULL, other_cost TEXT NOT NULL, recorded_at TEXT NOT NULL);
    ''')
    if 'channel' not in {row[1] for row in db.execute('PRAGMA table_info(pilot_order_economics)')}:
        db.execute("ALTER TABLE pilot_order_economics ADD COLUMN channel TEXT NOT NULL DEFAULT 'meta'")


def financial_fingerprint(payload):
    try:
        if payload.get('financial_status') != 'paid' or payload.get('currency') != 'EUR':
            return None
        lines = sorted((str(line['variant_id']), int(line['quantity'])) for line in payload['line_items'])
        content = [str(money(payload.get('current_total_price', payload.get('total_price'))).normalize()),
                   str(money(payload.get('current_total_tax', payload.get('total_tax'))).normalize()), lines]
        return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    except (KeyError, ValueError, TypeError, ArithmeticError, AttributeError):
        return None


def record_paid_order(db, *, topic, payload, order_hash, blocked, env, now):
    if blocked:
        db.execute('UPDATE pilot_order_economics SET blocked=1 WHERE order_hash=?', (order_hash,))
        return
    if topic == 'orders/updated':
        original = db.execute('SELECT digest FROM pilot_order_fingerprints WHERE order_hash=?', (order_hash,)).fetchone()
        if not original or financial_fingerprint(payload) != original[0]:
            db.execute('UPDATE pilot_order_economics SET blocked=1 WHERE order_hash=?', (order_hash,))
        return
    if topic != 'orders/paid':
        return
    try:
        at = instant(payload['updated_at'])
        if (payload.get('test') is not False or payload.get('financial_status') != 'paid'
                or payload.get('currency') != 'EUR' or payload.get('cancelled_at') is not None
                or (payload.get('shipping_address') or {}).get('country_code') not in {'DE', 'AT'}
                or not now - timedelta(days=7) <= at <= now):
            return
        landing = urlsplit(payload.get('landing_site') or '')
        if landing.netloc and landing.hostname not in {'homestro.de', 'www.homestro.de'}:
            return
        params = parse_qs(landing.query, keep_blank_values=True)
        if len(params.get('pilot_ref', [])) != 1:
            return
        ref = decode_ref(params['pilot_ref'][0], secret=env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY', ''), at=at)
        if not ref or params.get('utm_campaign') != [ref['campaign']] or params.get('utm_content') != [ref['ad']]:
            return
        if ref['channel'] != 'meta' and params.get('utm_source') != [ref['channel']]:
            return
        invalid = db.execute('SELECT blocked FROM payment_evidence WHERE order_hash=?', (order_hash,)).fetchone()
        if invalid and invalid[0]:
            return
        revenue = None
        try:
            total = money(payload.get('current_total_price', payload.get('total_price')))
            tax = money(payload.get('current_total_tax', payload.get('total_tax')))
            if total >= tax and total > 0:
                revenue = str(total - tax)
        except (ValueError, TypeError, ArithmeticError):
            pass
        lines = payload.get('line_items') or []
        if not isinstance(lines, list) or not all(isinstance(line, dict) for line in lines):
            lines = []
        cogs = Decimal('0') if 0 < len(lines) <= 200 else None
        for line in lines:
            variant, quantity = str(line.get('variant_id', '')), line.get('quantity')
            if not variant.isdigit() or type(quantity) is not int or not 0 < quantity <= 10000:
                cogs = None
                break
            cost = db.execute('SELECT amount,currency,observed_at FROM pilot_unit_costs WHERE variant=?', (variant,)).fetchone()
            if (not cost or cost[1] != 'EUR' or not at - timedelta(days=7) <= instant(cost[2]) <= at):
                cogs = None
                break
            if cogs is not None:
                cogs += money(cost[0]) * quantity
        inserted = db.execute('INSERT OR IGNORE INTO pilot_order_economics (order_hash,campaign,ad,experiment,paid_at,net_revenue,cogs,blocked,channel) VALUES (?,?,?,?,?,?,?,0,?)',
                   (order_hash, ref['campaign'], ref['ad'], ref['experiment'], at.isoformat(), revenue,
                    str(cogs) if cogs is not None else None, ref['channel'])).rowcount
        fingerprint = financial_fingerprint(payload)
        if inserted and fingerprint:
            db.execute('INSERT OR IGNORE INTO pilot_order_fingerprints VALUES (?,?)', (order_hash, fingerprint))
    except (ValueError, TypeError, KeyError, ArithmeticError, AttributeError):
        return


def economics_summary(store, campaign, spend_eur=0, *, channel='meta'):
    if channel not in CHANNELS:
        raise ValueError('unsupported attribution channel')
    with closing(store.connect()) as db:
        rows = db.execute('SELECT o.net_revenue,o.cogs,o.blocked,e.fulfillment,e.fees,e.returns_cost,e.other_cost '
                          'FROM pilot_order_economics o LEFT JOIN pilot_order_expenses e ON e.order_hash=o.order_hash '
                          'WHERE o.campaign=? AND o.channel=?', (campaign, channel)).fetchall()
        costs = db.execute('SELECT count(*) FROM pilot_unit_costs').fetchone()[0]
    active = [row for row in rows if not row[2]]
    complete = bool(active) and len(active) == len(rows) and all(all(value is not None for value in (row[0], row[1], *row[3:])) for row in active)
    contribution = (sum((Decimal(row[0]) - Decimal(row[1]) - sum(Decimal(value) for value in row[3:]) for row in active), Decimal('0'))
                    - money(spend_eur)) if complete and spend_eur is not None else None
    return {'channel': channel, 'campaign_id': campaign, 'signed_url_tagged_paid_orders': len(active),
            'refund_or_cancelled_orders': len(rows) - len(active), 'unit_cost_variants': costs,
            'missing_unit_cost_orders': sum(row[1] is None for row in active),
            'missing_expense_orders': sum(row[3] is None for row in active),
            'contribution_after_ads_eur': float(contribution) if contribution is not None else None,
            'costs_complete': complete, 'ad_spend_available': spend_eur is not None, 'attribution_method': 'signed_landing_url_observation',
            'causal_attribution_verified': False, 'net_profit_verified': False,
            'scale_authorized': False}


async def sync_unit_costs(store, *, env=None, client=None):
    import httpx

    env = os.environ if env is None else env
    domain = env.get('SHOPIFY_STORE_DOMAIN', '').removeprefix('https://').rstrip('/')
    version = env.get('SHOPIFY_API_VERSION', '2026-07')
    if (not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com', domain)
            or not re.fullmatch(r'20\d{2}-(01|04|07|10)', version)):
        return {'status': 'unavailable', 'reason': 'COST_SOURCE_NOT_CONFIGURED'}
    query = '''query PilotCostCoverage($after: String) { productVariants(first: 50, after: $after) {
      nodes { id inventoryItem { unitCost { amount currencyCode } } } pageInfo { hasNextPage endCursor } } }'''
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
    cursor, seen, values, missing = None, set(), {}, 0
    at = datetime.now(UTC).isoformat()
    try:
        token = env.get('SHOPIFY_ACCESS_TOKEN') or ''
        if not token:
            if not env.get('SHOPIFY_CLIENT_ID') or not env.get('SHOPIFY_CLIENT_SECRET'):
                return {'status': 'unavailable', 'reason': 'COST_EXISTING_APP_CREDENTIALS_UNAVAILABLE'}
            credentials = await client.post(f'https://{domain}/admin/oauth/access_token', data={
                'grant_type': 'client_credentials', 'client_id': env['SHOPIFY_CLIENT_ID'],
                'client_secret': env['SHOPIFY_CLIENT_SECRET']})
            credentials.raise_for_status()
            token = credentials.json().get('access_token')
            if not token:
                return {'status': 'unavailable', 'reason': 'COST_EXISTING_APP_TOKEN_UNAVAILABLE'}
        for _ in range(40):
            response = await client.post(f'https://{domain}/admin/api/{version}/graphql.json',
                headers={'X-Shopify-Access-Token': token}, json={'query': query, 'variables': {'after': cursor}})
            response.raise_for_status()
            body = response.json()
            if body.get('errors'):
                return {'status': 'unavailable', 'reason': 'COST_QUERY_REJECTED', 'existing_costs_preserved': True}
            page = body['data']['productVariants']
            for row in page['nodes']:
                variant = row['id'].removeprefix('gid://shopify/ProductVariant/')
                cost = row['inventoryItem']['unitCost']
                if variant in values:
                    return {'status': 'unavailable', 'reason': 'DUPLICATE_COST_VARIANT'}
                if not variant.isdigit() or not cost or cost['currencyCode'] != 'EUR' or money(cost['amount']) <= 0:
                    missing += 1
                    continue
                values[variant] = str(money(cost['amount']))
            if not page['pageInfo']['hasNextPage']:
                with closing(store.connect()) as db, db:
                    db.execute('DELETE FROM pilot_unit_costs')
                    db.executemany('INSERT INTO pilot_unit_costs VALUES (?,?,?,?) ON CONFLICT(variant) DO UPDATE SET '
                                   'amount=excluded.amount,currency=excluded.currency,observed_at=excluded.observed_at',
                                   [(variant, amount, 'EUR', at) for variant, amount in values.items()])
                return {'status': 'synchronized', 'unit_cost_variants': len(values), 'missing_cost_variants': missing,
                        'landed_costs_complete': False, 'source': 'shopify_inventory_unit_cost'}
            cursor = page['pageInfo']['endCursor']
            if not cursor or cursor in seen:
                break
            seen.add(cursor)
        return {'status': 'unavailable', 'reason': 'COST_PAGINATION_INCOMPLETE', 'existing_costs_preserved': True}
    except Exception as exc:
        return {'status': 'unavailable', 'reason': 'COST_SOURCE_UNAVAILABLE', 'error_type': type(exc).__name__}
    finally:
        if own:
            await client.aclose()
