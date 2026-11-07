import unittest
from datetime import UTC, datetime, timedelta

from adtech_pilot.autonomous_brain import next_product_batch
from adtech_pilot.product_selection import select_cost_candidates


class ProductSelectionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(UTC)

    def product(self, index, price='39.90', **extra):
        return {'id': f'gid://shopify/ProductVariant/{index}', 'title': f'Produkt {index}',
                'price': price, 'currency': 'EUR', 'availability': 'in_stock',
                'link': f'https://homestro.de/products/p-{index}', 'image_link': 'https://cdn.shopify.com/p.jpg', **extra}

    def costs(self, values, *, age_days=0):
        return {str(key): {'amount': value, 'currency': 'EUR',
                          'observed_at': (self.now - timedelta(days=age_days)).isoformat()} for key, value in values.items()}

    def test_reads_real_costs_and_labels_headroom_without_net_profit_claim(self):
        products, result = select_cost_candidates([self.product(1)], self.costs({1: '5'}), now=self.now)
        self.assertEqual(products[0]['pilot_gross_headroom_eur'], '34.90')
        self.assertEqual(products[0]['pilot_cost_basis'], 'shopify_inventory_unit_cost')
        self.assertFalse(result['net_profit_verified'])
        self.assertFalse(result['budget_increase_authorized'])
        self.assertIn('payment_fees', result['excluded_from_headroom'])

    def test_legacy_price_and_cost_ratio_limits_are_removed(self):
        products, result = select_cost_candidates([
            self.product(1, '34.90'), self.product(2, '39.90'),
            self.product(3, '50'), self.product(4, '29.90')
        ], self.costs({1: 10, 2: 15, 3: 15, 4: 5}), now=self.now)
        self.assertEqual(len(products), 4)
        self.assertEqual(result['eligible_product_pages'], 4)
        self.assertEqual(result['policy']['minimum_retail_eur'], '9.90')

    def test_low_price_products_pass_at_990_and_keep_real_cost(self):
        products, _ = select_cost_candidates([self.product(1, '9.90')], self.costs({1: '8.50'}), now=self.now)
        self.assertEqual(len(products), 1)
        self.assertEqual(products[0]['pilot_gross_headroom_eur'], '1.40')

    def test_missing_stale_future_non_eur_and_invalid_costs_use_33_percent_estimate(self):
        inputs = [
            {}, self.costs({1: 5}, age_days=8), self.costs({1: 5}, age_days=-1),
            self.costs({1: 0}), self.costs({1: 'NaN'}),
            {'1': {'amount': '5', 'currency': 'USD', 'observed_at': self.now.isoformat()}}
        ]
        for costs in inputs:
            products, result = select_cost_candidates([self.product(1, '9.90')], costs, now=self.now)
            self.assertEqual(products[0]['pilot_unit_cost_eur'], '3.27')
            self.assertEqual(products[0]['pilot_gross_headroom_eur'], '6.63')
            self.assertEqual(products[0]['pilot_cost_basis'], 'estimated_33pct_of_retail')
            self.assertEqual(result['estimated_cost_variants'], 1)

    def test_prices_below_minimum_remain_ineligible(self):
        products, result = select_cost_candidates([self.product(1, '9.89')], {}, now=self.now)
        self.assertEqual(products, [])
        self.assertEqual(result['rejected_by_reason']['BELOW_MINIMUM_RETAIL'], 1)

    def test_headroom_ranks_equally_explored_products_but_does_not_starve_unexplored_items(self):
        products, _ = select_cost_candidates([self.product(1), self.product(2)], self.costs({1: 10, 2: 5}), now=self.now)
        self.assertEqual(next_product_batch(products, {}, limit=1)[0]['id'], 'gid://shopify/ProductVariant/2')
        self.assertEqual(next_product_batch(products, {'gid://shopify/ProductVariant/2': 1}, limit=1)[0]['id'], 'gid://shopify/ProductVariant/1')

    def test_unavailable_products_remain_ineligible_even_with_estimated_cost(self):
        products, _ = select_cost_candidates([self.product(1, availability='out_of_stock')], {}, now=self.now)
        self.assertEqual(products, [])

    def test_same_product_url_keeps_distinct_variant_ids_and_collapses_exact_repeats(self):
        first = self.product(11, link='https://homestro.de/products/same')
        second = self.product(12, link='https://homestro.de/products/same?variant=12')
        duplicate = {**first, 'link': first['link']+'?utm_source=feed'}
        products, result = select_cost_candidates(
            [first, second, duplicate], self.costs({11: 5, 12: 6}), now=self.now
        )
        self.assertEqual({product['id'] for product in products}, {first['id'], second['id']})
        self.assertEqual(result['eligible_product_pages'], 1)
        self.assertEqual(result['rejected_by_reason']['DUPLICATE_PRODUCT_URL'], 1)
