import json
import unittest

from adtech_pilot.content_engine import content_batch, product_draft


class ContentEngineTests(unittest.TestCase):
    def product(self, **extra):
        return {'id': 'gid://shopify/ProductVariant/123', 'title': 'Aufbewahrungsbox',
                'price': '39.90', 'currency': 'EUR', 'availability': 'in_stock',
                'link': 'https://homestro.de/products/box?variant=123&utm_source=meta',
                'image_link': 'https://cdn.shopify.com/box.jpg', **extra}

    def test_search_schema_only_uses_actual_offer_and_preserves_variant(self):
        draft = product_draft(self.product())
        offer = draft['geo']['product_json_ld']['offers']
        self.assertEqual(offer['price'], '39.90')
        self.assertEqual(offer['priceCurrency'], 'EUR')
        self.assertIn('variant=123', offer['url'])
        self.assertEqual(draft['seo']['canonical_suggestion'], 'https://homestro.de/products/box')
        self.assertNotIn('aggregateRating', json.dumps(draft))
        self.assertFalse(draft['publication_performed'])
        self.assertFalse(draft['geo']['ai_search_inclusion_verified'])

    def test_unavailable_or_external_products_cannot_generate_drafts(self):
        for extra in ({'availability': 'out_of_stock'}, {'currency': 'USD'},
                      {'link': 'https://external.example/products/box'}):
            with self.assertRaises(ValueError):
                product_draft(self.product(**extra))

    def test_no_quality_shipping_or_sales_claims_are_added(self):
        draft = product_draft(self.product())
        for claim in ('Premium Qualität', 'Blitzschneller Versand', 'Garantierte Zufriedenheit', 'Bestseller'):
            self.assertNotIn(claim, json.dumps(draft, ensure_ascii=False))
        self.assertFalse(draft['unsupported_claims_added'])
        self.assertFalse(draft['paid_generation_performed'])

    def test_canonical_dedup_prevents_recreating_each_variant_as_content(self):
        result = content_batch([self.product(), self.product(id='124',
            link='https://homestro.de/products/box?variant=124')])
        self.assertEqual(result['draft_count'], 1)

    def test_batch_skips_invalid_and_limits_preview(self):
        result = content_batch([self.product(availability='out_of_stock')] + [self.product(
            id=str(i), link=f'https://homestro.de/products/box-{i}') for i in range(10)])
        self.assertEqual(result['draft_count'], 3)
        self.assertEqual(result['invalid_candidates_skipped'], 1)
        self.assertFalse(result['publication_performed'])

    def test_product_name_is_not_presented_as_verified_translation(self):
        result = product_draft(self.product(title='<b>Storage Box</b>'))
        self.assertEqual(result['seo']['h1'], 'Storage Box')
        self.assertFalse(result['product_name_language_verified'])
        self.assertEqual(result['brief_version'], '2026-10-25.1')
