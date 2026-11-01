"""Cost-aware test candidates, with gross headroom explicitly separate from profit."""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .order_economics import instant, money
from .website_ads import product_path, website_story


def select_cost_candidates(products, costs, *, now=None):
    """Keep each valid feed product; use measured EUR COGS or a labeled 33% estimate.

    The selection stage does not apply purchase-price, retail-price, or margin
    thresholds. Catalog inclusion is controlled by Shopify/Meta's All products set.
    """
    now = now or datetime.now(UTC)
    accepted, rejected, seen = [], Counter(), set()
    for raw in products:
        try:
            _, ids = website_story([raw], '12345')
            variant = ids[0].removeprefix('gid://shopify/ProductVariant/')
            retail = money(raw['price'])
            if retail <= 0:
                rejected['PRICE_INVALID'] += 1
                continue

            cost = costs.get(variant)
            basis = 'estimated_33_percent_of_retail'
            purchase = (retail * Decimal('0.33')).quantize(Decimal('0.01'))
            observed_at = None
            if cost and cost.get('currency') == 'EUR':
                observed = instant(cost.get('observed_at'))
                if now - timedelta(days=7) <= observed <= now:
                    measured = money(cost.get('amount'))
                    if measured > 0:
                        purchase, basis, observed_at = measured, 'shopify_unit_cost', cost['observed_at']

            path = product_path(raw['link'])
            if path in seen:
                rejected['DUPLICATE_PRODUCT_URL'] += 1
                continue
            seen.add(path)
            headroom = retail - purchase
            accepted.append({
                **raw,
                'pilot_gross_headroom_eur': str(headroom),
                'pilot_unit_cost_eur': str(purchase),
                'pilot_cost_basis': basis,
                'pilot_cost_observed_at': observed_at,
            })
        except (ValueError, KeyError, TypeError, ArithmeticError):
            rejected['PRODUCT_OR_PRICE_INVALID'] += 1
    accepted.sort(key=lambda product: (-Decimal(product['pilot_gross_headroom_eur']), str(product['id'])))
    return accepted, {
        'status': 'evaluated',
        'products_checked': len(products),
        'eligible_products': len(accepted),
        'rejected_by_reason': dict(rejected),
        'basis': 'shopify_unit_cost_or_explicit_33_percent_fallback',
        'landed_costs_complete': False,
        'net_profit_verified': False,
        'budget_increase_authorized': False,
        'policy': {
            'missing_or_stale_cost_fallback_percent': 33,
            'retail_price_floor_eur': None,
            'purchase_cost_ceiling_eur': None,
            'margin_ratio_floor': None,
        },
        'candidate_preview': [{
            'product_id': str(p['id']),
            'retail_eur': str(p['price']),
            'unit_cost_eur': p['pilot_unit_cost_eur'],
            'cost_basis': p['pilot_cost_basis'],
            'gross_headroom_eur': p['pilot_gross_headroom_eur'],
        } for p in accepted[:20]],
        'excluded_from_headroom': [
            'fulfillment_cost', 'payment_fees', 'returns', 'advertising', 'tax_adjustments'
        ],
    }


def read_cost_candidates(store, products, *, now=None):
    with closing(store.connect()) as db:
        rows = db.execute('SELECT variant,amount,currency,observed_at FROM pilot_unit_costs').fetchall()
    costs = {variant: {'amount': amount, 'currency': currency, 'observed_at': at}
             for variant, amount, currency, at in rows}
    return select_cost_candidates(products, costs, now=now)
