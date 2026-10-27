import unittest

from adtech_pilot.website_ads import website_story


class WebsiteAdsTests(unittest.TestCase):
    def product(self, index, **extra):
        return {"id": str(index), "title": "Praktischer Küchenhelfer", "price": "39.90", "currency": "EUR",
                "availability": "in_stock", "link": f"https://homestro.de/products/produkt-{index}",
                "image_link": "https://cdn.shopify.com/product.jpg", **extra}

    def test_many_products_use_direct_links_without_catalog_or_paid_generation(self):
        story, ids = website_story([self.product(i) for i in range(20)], "12345")
        self.assertEqual(len(ids), 10)
        self.assertEqual(len(story["link_data"]["child_attachments"]), 10)
        self.assertNotIn("template_data", story)
        self.assertNotIn("product_set_id", story)
        self.assertNotIn("Premium", story["link_data"]["message"])

    def test_deduplicates_product_urls_and_rejects_unavailable_hidden_rejected(self):
        products = [self.product(1), self.product(1), self.product(2, availability="out_of_stock"),
                    self.product(3, status="DRAFT"), self.product(4, tags=["homestro-ai-rejected"]),
                    self.product(5, currency="USD")]
        story, ids = website_story(products, "12345")
        self.assertEqual(ids, ["1"])
        self.assertIn("picture", story["link_data"])

    def test_no_eligible_products_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "NO_ELIGIBLE_WEBSITE_PRODUCTS"):
            website_story([self.product(1, link="https://example.com")], "12345")

    def test_explicitly_rejected_brush_and_silicone_spatulas_never_qualify_and_variant_cards_deduplicate(self):
        from adtech_pilot.website_ads import owner_excluded

        brush = self.product(1, link='https://homestro.de/products/pet-combs-knot-opening-combs-massage-combs-electric-steam-spray-brushes-de-floating-pet-products-cat-combs')
        spatula = self.product(2, title='Silikon Spachtel Set')
        self.assertTrue(owner_excluded(brush))
        self.assertTrue(owner_excluded(spatula))
        allowed = self.product(3)
        variant = {**allowed, 'id': '4', 'link': allowed['link']+'?variant=4'}
        _, ids = website_story([brush, spatula, allowed, variant], '12345')
        self.assertEqual(ids, ['3'])
