"""Cost-aware candidates; unknown supplier costs use an explicit 33% estimate."""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import urlsplit

from .order_economics import instant, money
from .website_ads import product_variant_identity, website_story

MIN_RETAIL_EUR = Decimal('9.90')
FALLBACK_COST_RATIO = Decimal('0.33')
COST_FRESHNESS = timedelta(days=7)


def _recent_real_cost(cost, now):
    if not cost or cost.get('currency') != 'EUR':
        return None
    try:
        observed_at = instant(cost['observed_at'])
        amount = money(cost['amount'])
    except (KeyError, TypeError, ValueError, ArithmeticError):
        return None
    if not now - COST_FRESHNESS <= observed_at <= now or amount <= 0:
        return None
    return amount


def select_cost_candidates(products, costs, *, now=None):
    """Include every available EUR variant priced >= €9.90.

    Fresh positive Shopify unit costs remain authoritative. Missing, stale, invalid,
    or non-EUR costs are estimated at 33% of retail and are labelled as estimates.
    The result ranks by gross headroom; it does not claim net profit or authorize spend.
    """
    now = now or datetime.now(UTC)
    accepted, rejected, seen, pages = [], Counter(), set(), set()
    estimated_cost_count = 0
    actual_cost_count = 0
    for raw in products:
        try:
            _, ids = website_story([raw], '12345')
            variant = ids[0].removeprefix('gid://shopify/ProductVariant/')
            retail = money(raw['price'])
            if retail < MIN_RETAIL_EUR:
                rejected['BELOW_MINIMUM_RETAIL'] += 1
                continue

            actual_cost = _recent_real_cost((costs or {}).get(variant), now)
            if actual_cost is None:
                purchase = (retail * FALLBACK_COST_RATIO).quantize(Decimal('0.01'))
                cost_basis = 'estimated_33pct_of_retail'
                estimated_cost_count += 1
            else:
                purchase = actual_cost
                cost_basis = 'shopify_inventory_unit_cost'
                actual_cost_count += 1

            headroom = retail - purchase
            identity = product_variant_identity(raw, variant)
            if identity in seen:
                rejected['DUPLICATE_PRODUCT_URL'] += 1
                continue
            seen.add(identity)
            link = str(raw.get('link') or '')
            product_path = urlsplit(link)._replace(query='', fragment='').geturl().rstrip('/')
            pages.add(product_path or str(raw.get('id') or variant))
            accepted.append({**raw, 'pilot_gross_headroom_eur': str(headroom),
                             'pilot_unit_cost_eur': str(purchase),
                             'pilot_cost_basis': cost_basis,
                             'pilot_cost_observed_at': (costs or {}).get(variant, {}).get('observed_at')
                             if cost_basis == 'shopify_inventory_unit_cost' else None})
        except (ValueError, KeyError, TypeError, ArithmeticError):
            rejected['PRODUCT_OR_COST_INVALID'] += 1

    accepted.sort(key=lambda product: (-Decimal(product['pilot_gross_headroom_eur']), str(product['id'])))
    negative_headroom = sum(Decimal(p['pilot_gross_headroom_eur']) < 0 for p in accepted)
    return accepted, {
        'status': 'evaluated',
        'products_checked': len(products),
        'eligible_products': len(accepted),
        'eligible_product_pages': len(pages),
        'estimated_cost_variants': estimated_cost_count,
        'shopify_cost_variants': actual_cost_count,
        'negative_gross_headroom_variants': negative_headroom,
        'rejected_by_reason': dict(rejected),
        'basis': 'shopify_unit_cost_or_33pct_fallback_and_feed_retail_price',
        'landed_costs_complete': False,
        'net_profit_verified': False,
        'budget_increase_authorized': False,
        'policy': {'minimum_retail_eur': str(MIN_RETAIL_EUR),
                   'missing_or_stale_cost_ratio': str(FALLBACK_COST_RATIO),
                   'minimum_gross_headroom_eur': None,
                   'cost_to_retail_ratio_limit': None},
        'candidate_preview': [{'product_id': str(p['id']), 'retail_eur': str(p['price']),
                               'unit_cost_eur': p['pilot_unit_cost_eur'],
                               'cost_basis': p['pilot_cost_basis'],
                               'gross_headroom_eur': p['pilot_gross_headroom_eur']} for p in accepted[:20]],
        'excluded_from_headroom': ['fulfillment_cost', 'payment_fees', 'returns', 'advertising', 'tax_adjustments'],
    }


def read_cost_candidates(store, products, *, now=None):
    with closing(store.connect()) as db:
        rows = db.execute('SELECT variant,amount,currency,observed_at FROM pilot_unit_costs').fetchall()
    costs = {variant: {'amount': amount, 'currency': currency, 'observed_at': at}
             for variant, amount, currency, at in rows}
    return select_cost_candidates(products, costs, now=now)
