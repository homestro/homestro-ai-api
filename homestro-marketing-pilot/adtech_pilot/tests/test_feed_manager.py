import json
import unittest

from adtech_pilot.feed_manager import ProductFeedManager


class FeedManagerTests(unittest.TestCase):
    def setUp(self):
        self.manager = ProductFeedManager()

    def test_json_is_validated_and_prepared_without_upload(self):
        row = {
            "id": "sku-1",
            "title": "Napf",
            "description": "Keramiknapf für Hunde",
            "link": "https://homestro.de/products/napf",
            "image_link": "https://cdn.shopify.com/a.jpg",
            "price": "19,90 EUR",
            "availability": "in stock",
            "brand": "Homestro",
            "mpn": "sku-1",
        }
        report = self.manager.parse(json.dumps({"products": [row]}), "application/json")
        self.assertTrue(report.valid)
        self.assertIn("GTIN_MISSING", [x.code for x in report.issues])
        prepared = self.manager.prepare_channels(report)
        self.assertEqual(len(prepared["meta"]), 1)
        self.assertEqual(len(prepared["google"]), 1)

    def test_missing_description_blocks_all_channels(self):
        row = {
            "id": "sku-1",
            "title": "Napf",
            "link": "https://homestro.de/products/napf",
            "image_link": "https://cdn.shopify.com/a.jpg",
            "price": "19.90 EUR",
            "availability": "in_stock",
            "brand": "Homestro",
            "mpn": "sku-1",
        }
        report = self.manager.parse(json.dumps([row]), "application/json")
        self.assertFalse(report.valid)
        self.assertIn("DESCRIPTION_MISSING", [x.code for x in report.issues])
        self.assertTrue(
            all(not rows for rows in self.manager.prepare_channels(report).values())
        )

    def test_bad_url_characters_and_bad_gtin_are_rejected(self):
        row = {
            "id": "x",
            "title": "Bad",
            "description": "Text",
            "link": "https://homestro.de/products/a b",
            "image_link": "https://cdn.shopify.com/a.jpg",
            "price": 3.99,
            "gtin": "1234",
        }
        report = self.manager.parse(json.dumps([row]), "application/json")
        self.assertEqual(report.rejected_rows, 1)
        self.assertIn("PRODUCT_INVALID", [x.code for x in report.issues])

    def test_xml_google_feed(self):
        xml = b"""<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><item>
        <g:id>x1</g:id><g:title>Produkt</g:title><g:description>Deutsch</g:description>
        <g:link>https://homestro.de/products/x</g:link><g:image_link>https://cdn.shopify.com/x.jpg</g:image_link>
        <g:price>9.99 EUR</g:price><g:availability>in_stock</g:availability><g:brand>Homestro</g:brand><g:mpn>x1</g:mpn>
        </item></channel></rss>"""
        report = self.manager.parse(xml, "application/xml")
        self.assertEqual(report.source_format, "xml")
        self.assertEqual(str(report.products[0].price), "9.99")
        self.assertEqual(len(self.manager.prepare_channels(report)["google"]), 1)

    def test_single_shopify_product_json_is_normalized_without_publishing(self):
        product = {
            "id": 16104466776446,
            "title": "Lenovo Erazer XP6",
            "handle": "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5",
            "description": "<p>Bluetooth <strong>5.4</strong> und IPX5.</p>",
            "vendor": "Homestro",
            "type": "Bluetooth-Kopfhörer",
            "tags": ["Bluetooth 5.4"],
            "available": True,
            "images": ["//cdn.shopify.com/files/earbuds.webp"],
            "variants": [{"price": 4799, "available": True}],
        }
        report = self.manager.parse(json.dumps(product), "application/json")
        self.assertEqual(report.source_format, "shopify-product-json")
        self.assertTrue(report.valid)
        self.assertEqual(report.products[0].id, "16104466776446")
        self.assertEqual(str(report.products[0].price), "47.99")
        self.assertEqual(report.products[0].availability, "in_stock")
        self.assertTrue(report.products[0].image_link.startswith("https://"))
        self.assertIn("Bluetooth 5.4", report.products[0].description)
        self.assertEqual(len(self.manager.prepare_channels(report)["meta"]), 1)

    def test_single_shopify_product_without_available_variant_is_rejected(self):
        product = {
            "id": 16104466776446,
            "title": "Lenovo Erazer XP6",
            "handle": "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5",
            "variants": [{"price": 4799, "available": False}],
        }
        report = self.manager.parse(json.dumps(product), "application/json")
        self.assertFalse(report.valid)
        self.assertEqual(report.rejected_rows, 1)

    def test_dtd_and_entity_expansion_are_rejected(self):
        xml = b'<!DOCTYPE x [<!ENTITY e "boom">]><rss><channel><item><title>&e;</title></item></channel></rss>'
        report = self.manager.parse(xml, "application/xml")
        self.assertFalse(report.valid)
        self.assertIn("FEED_PARSE_ERROR", [x.code for x in report.issues])


if __name__ == "__main__":
    unittest.main()
