import unittest
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from adtech_pilot.product_intent import ProductIntentSnapshot, rank_product_intent


class ProductIntentTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 21, 12, tzinfo=UTC)

    def row(self, **changes):
        values = {
            "product_id": "sku-1",
            "views": 100,
            "add_to_cart": 3,
            "initiate_checkout": 1,
            "purchases": 0,
            "contribution_margin_eur": Decimal("4.00"),
            "available": True,
            "ingestion_verified": True,
            "observed_at": self.now,
        }
        values.update(changes)
        return ProductIntentSnapshot(**values)

    def test_checkout_and_verified_margin_qualify_without_views_as_proof(self):
        candidate = rank_product_intent([self.row()], now=self.now)[0]
        self.assertTrue(candidate.eligible_for_review)
        self.assertEqual(candidate.score, 41.0)

    def test_views_alone_never_make_a_candidate(self):
        candidate = rank_product_intent(
            [self.row(add_to_cart=0, initiate_checkout=0, purchases=0)],
            now=self.now,
        )[0]
        self.assertFalse(candidate.eligible_for_review)
        self.assertIn("INSUFFICIENT_HIGH_INTENT_EVENTS", candidate.blockers)

    def test_missing_data_stock_or_margin_fails_closed(self):
        rows = [
            self.row(product_id="unverified", ingestion_verified=False),
            self.row(product_id="oos", available=False),
            self.row(product_id="margin", contribution_margin_eur=None),
        ]
        results = rank_product_intent(rows, now=self.now)
        self.assertTrue(all(not row.eligible_for_review for row in results))

    def test_stale_data_cannot_qualify(self):
        candidate = rank_product_intent(
            [self.row(observed_at=self.now - timedelta(days=4))],
            now=self.now,
        )[0]
        self.assertFalse(candidate.eligible_for_review)
        self.assertIn("EVENT_DATA_STALE_OR_FUTURE", candidate.blockers)

    def test_purchase_dominates_shallow_traffic(self):
        rows = [
            self.row(product_id="views", views=10000, add_to_cart=0, initiate_checkout=0),
            self.row(product_id="purchase", views=1, add_to_cart=0, initiate_checkout=0, purchases=1),
        ]
        ranked = rank_product_intent(rows, now=self.now)
        self.assertEqual(ranked[0].product_id, "purchase")
        self.assertTrue(ranked[0].eligible_for_review)
        self.assertFalse(ranked[1].eligible_for_review)


if __name__ == "__main__":
    unittest.main()
