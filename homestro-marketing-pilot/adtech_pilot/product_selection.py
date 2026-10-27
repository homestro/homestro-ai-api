"""Cost-aware test candidates, with gross headroom explicitly separate from profit."""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .order_economics import instant, money
from .website_ads import product_path, website_story


def select_cost_candidates(products, costs, *, now=None):
    now = now or datetime.now(UTC)
    accepted, rejected, seen = [], Counter(), set()
    for raw in products:
        try:
            _, ids = website_story([raw], '12345')
            variant = ids[0].removeprefix('gid://shopify/ProductVariant/')
            cost = costs.get(variant)
            if not cost or cost.get('currency') != 'EUR':
                rejected['COST_UNKNOWN_OR_NON_EUR'] += 1
                continue
            if not now - timedelta(days=7) <= instant(cost['observed_at']) <= now:
                rejected['COST_STALE_OR_FUTURE'] += 1
                continue
            purchase, retail = money(cost['amount']), money(raw['price'])
            if purchase <= 0:
                rejected['COST_NOT_POSITIVE'] += 1
                continue
            headroom = retail - purchase
            standard = purchase <= 10 and retail >= Decimal('34.90') and retail >= purchase * 3
            extended = 10 < purchase <= 15 and Decimal('38') <= retail <= 45
            if not (standard or extended) or headroom < 10:
                rejected['OUTSIDE_OWNER_PRODUCT_PRICE_LIMITS'] += 1
                continue
            if product_path(raw['link']) in seen:
                rejected['DUPLICATE_PRODUCT_URL'] += 1
                continue
            seen.add(product_path(raw['link']))
            accepted.append({**raw, 'pilot_gross_headroom_eur': str(headroom),
                             'pilot_unit_cost_eur': str(purchase),
                             'pilot_cost_observed_at': cost['observed_at']})
        except (ValueError, KeyError, TypeError, ArithmeticError):
            rejected['PRODUCT_OR_COST_INVALID'] += 1
    accepted.sort(key=lambda product: (-Decimal(product['pilot_gross_headroom_eur']), str(product['id'])))
    return accepted, {
        'status': 'evaluated', 'products_checked': len(products), 'eligible_products': len(accepted),
        'rejected_by_reason': dict(rejected), 'basis': 'shopify_unit_cost_and_feed_retail_price',
        'landed_costs_complete': False, 'net_profit_verified': False,
        'budget_increase_authorized': False,
        'policy': {'standard_max_unit_cost_eur': 10, 'standard_min_retail_eur': 34.9,
                   'standard_min_retail_cost_ratio': 3, 'extended_max_unit_cost_eur': 15,
                   'extended_retail_range_eur': [38, 45], 'minimum_gross_headroom_eur': 10},
        'candidate_preview': [{'product_id': str(p['id']), 'retail_eur': str(p['price']),
                               'unit_cost_eur': p['pilot_unit_cost_eur'],
                               'gross_headroom_eur': p['pilot_gross_headroom_eur']} for p in accepted[:20]],
        'excluded_from_headroom': ['fulfillment_cost', 'payment_fees', 'returns', 'advertising', 'tax_adjustments'],
    }


def read_cost_candidates(store, products, *, now=None):
    with closing(store.connect()) as db:
        rows = db.execute('SELECT variant,amount,currency,observed_at FROM pilot_unit_costs').fetchall()
    costs = {variant: {'amount': amount, 'currency': currency, 'observed_at': at}
             for variant, amount, currency, at in rows}
    return select_cost_candidates(products, costs, now=now)
