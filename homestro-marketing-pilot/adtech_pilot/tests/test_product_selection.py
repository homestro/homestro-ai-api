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
        self.assertFalse(result['net_profit_verified'])
        self.assertFalse(result['budget_increase_authorized'])
        self.assertIn('payment_fees', result['excluded_from_headroom'])

    def test_standard_and_extended_owner_limits(self):
        products, _ = select_cost_candidates([self.product(1, '34.90'), self.product(2, '39.90'),
            self.product(3, '50'), self.product(4, '29.90')], self.costs({1: 10, 2: 15, 3: 15, 4: 5}), now=self.now)
        self.assertEqual({p['id'] for p in products}, {'gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'})

    def test_unknown_stale_future_non_eur_and_invalid_costs_are_not_invented(self):
        for costs in ({}, self.costs({1: 5}, age_days=8), self.costs({1: 5}, age_days=-1),
                      self.costs({1: 0}), self.costs({1: 'NaN'}),
                      {'1': {'amount': '5', 'currency': 'USD', 'observed_at': self.now.isoformat()}}):
            products, _ = select_cost_candidates([self.product(1)], costs, now=self.now)
            self.assertEqual(products, [])

    def test_headroom_ranks_equally_explored_products_but_does_not_starve_unexplored_items(self):
        products, _ = select_cost_candidates([self.product(1), self.product(2)], self.costs({1: 10, 2: 5}), now=self.now)
        self.assertEqual(next_product_batch(products, {}, limit=1)[0]['id'], 'gid://shopify/ProductVariant/2')
        self.assertEqual(next_product_batch(products, {'gid://shopify/ProductVariant/2': 1}, limit=1)[0]['id'], 'gid://shopify/ProductVariant/1')

    def test_unavailable_products_remain_ineligible_even_with_large_headroom(self):
        products, _ = select_cost_candidates([self.product(1, availability='out_of_stock')], self.costs({1: 1}), now=self.now)
        self.assertEqual(products, [])
