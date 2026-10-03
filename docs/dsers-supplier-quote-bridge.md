# DSers supplier cost bridge

DSers can send either product cost alone or product plus shipping into Shopify
variant `Cost per item`. This field alone does not prove destination, supplier
mapping, shipping availability or taxes. A zero shipping amount may also mean
that DSers has no supported configured shipping method. Confirm the DSers
shipping quote for Germany before recording a zero.

Official documentation:
https://help.dsers.com/send-product-cost-information/
https://help.dsers.com/auto-sync-product-shipping-costs-to-your-store/

## Existing workflow

Railway finds AliExpress URLs. The merchant manually imports through DSers
into Shopify DRAFT. This bridge then records an explicit operator-confirmed
DSers/supplier quote. It does not create products, import from DSers, publish,
change sale prices, place orders or connect to an unavailable DSers API.

## Read requirements

`GET /api/supplier-bridge/product?productId=<Shopify Product GID>` requires the
existing Homestro bearer credential. It returns the current DRAFT's variant
IDs, SKUs, costs and existing supplier fields. No costs are inferred.

## Record a confirmed quote

`POST /api/supplier-bridge/quote` uses the same authentication. Its body has
`productId` and a `quote` object with:

- `sourceUrl`: actual AliExpress item URL from the DSers supplier mapping.
- `currency`: `EUR`; `destinationCountry`: `DE`.
- `quotedAt`: ISO timestamp from the current supplier quote, at most 24 hours
  old and no more than five minutes in the future.
- `shopifyUnitCostBasis`: `PRODUCT_ONLY` or `PRODUCT_AND_SHIPPING`, matching
  the actual DSers setting. Do not infer this from the numeric amount.
- `variants`: one row per current Shopify variant, containing `variantId`,
  exact current `shopifySku`, mapped `supplierVariantId`, actual `sourceUrl`,
  numeric `supplierCostEur`, `shippingEur` and `procurementTaxEur`. Unknown
  amounts must remain unknown, never zero-filled.

The bridge checks every row against the current DRAFT, source ID, SKU, cost,
currency and destination. With `PRODUCT_AND_SHIPPING`, it reconciles the
Shopify cost against product plus shipping, avoiding double counting. It
creates or checks merchant-owned `homestro` field definitions so the existing
autopilot and merchant tools can read the same data, then writes the source URL,
product ID and JSON evidence atomically with compare-and-set digests. It reads
Shopify back before reporting success. An expired or mismatched quote keeps
the existing autopilot's landed-cost gate pending.

After a real quote is stored, process only the selected DRAFT using the existing
`POST /api/catalog/process-existing` with `productId`. Existing content, image,
variant and collection QA still apply; valid cost evidence alone does not mean
the product is complete. The bridge does not enable background batches.

## Validation

The tests cover product-only and combined DSers costs, missing shipping, stale
and future quotes, incorrect supplier or SKU, partial variants, ACTIVE products,
concurrent activation, atomic write conflicts and incorrect Shopify readback.
