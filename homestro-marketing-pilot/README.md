# Homestro Organic Marketing Pilot — integration candidate

This package is written and locally tested. It has NOT been deployed, connected to a live PostgreSQL instance, or used to publish a live Meta post. Do not describe the package as an already running autonomous service.

## Final behavior

1. Read the full Shopify product, paginating both media and variants.
2. Preserve Shopify prices. Missing supplier reference/cost becomes a recorded pending item, not a pipeline exception. Numeric cost fallback is zero; verified margin remains NULL. No price mutation exists in this package.
3. Use reviewed German copy, or an injected localization engine. Cache localized copy per product revision. Generated titles, descriptions and SEO metadata stay in this database; writing them back to Shopify is deliberately not part of this package.
4. If Shopify has a READY MP4 video, normalize it to a 720×1280 Reel (maximum 30 seconds) with a German text hook for the first 3 seconds. Source audio is removed: do not assume supplier music has licensed publishing rights.
5. If no MP4 exists, prepare 2–10 JPEG images for an Instagram carousel and Facebook organic multi-photo post. One image produces a single-image post. There is NO video slideshow fallback. JPEGs are fitted, not cropped, into a common 1080×1350 frame and cached on disk.
6. Save the German caption, UTM link, format and public asset URLs as `draft_queued`. In the enabled Homestro autonomy policy, a structurally validated German copy and a currently available Shopify variant with a positive live price are approved automatically. The pilot reads that price for the post and never changes it. Rejected, unavailable, incomplete or changed products stay blocked.
7. A minute scheduler publishes one approved post at a time, at most 6 posts total and 3 per channel per rolling 24 hours by default. Set both caps lower if desired. Database advisory locks prevent normal overlapping workers. Periodic catalog scans cover ALL active products, not only the first 30.
8. Serve a fresh XML feed (default 50 variant offers), validating current Shopify price/stock at request time. Google must fetch it; it does not instantly update Merchant Center. This package does not fix account Misrepresentation, claim a domain, guarantee indexing or create ads.

## State machine

Product: `pending_marketing` → `ready` after missing information/reviews are resolved.

Post: `draft_queued` → **approved under the configured owner policy** → `publishing` → **published**.

`published` is a result, NEVER a trigger. Only the worker can set it after Meta confirms publication. A changed product invalidates an old approval (`superseded`). An uncertain upload/publication or interrupted worker enters `recovery_required`, with remote container/video/photo IDs saved. It is never blindly auto-republished. Inspect those IDs on Meta before any manual recovery. This sacrifices unattended retries to avoid duplicate public posts.

Facebook Reels use start → hosted upload → uploading-complete → finish → processing/publishing confirmation. The finish call starts Facebook's encoding; waiting for encoding before finish can deadlock. Instagram uses create → FINISHED → media_publish. Carousels create child image containers before the parent.

## Files / five requested modules

| Module | Files |
| --- | --- |
| 1. Ingestion and localization | `modules/ingestion.js`, `localization.js`, `shopify.js` |
| 2. Media extraction / video priority / carousel fallback | `modules/media.js` |
| 3. Organic Meta distribution | `modules/meta.js`, `worker.js` |
| 4. Google organic XML | `modules/feed.js` |
| 5. Approval and durability | `schema.sql`, `modules/store.js`, `modules/index.js` |

## Install on Railway

- Node 22+, PostgreSQL, FFmpeg/ffprobe, DejaVu fonts, persistent volume mounted at `/data`.
- Add `pg` and `express` dependencies to the existing application, or use this standalone Docker example. Keep the existing application's start command when integrating into it. Do not replace the shop's production server with `server.example.js`.
- Fill environment settings from `.env.example`. Never paste tokens into chat or commit populated environment files.
- The startup SQL only creates its own marketing tables. Marketing initialization failures are caught, so the existing application can still start.
- Keep ALL three feature switches false initially. Run the unit tests and a real staging database check first.
- This uses the Facebook Login integration, Page token and linked professional Instagram account. Existing Homestro IDs are preset. Verify token validity, content publishing permissions, account role/app mode and Instagram link-in-bio before enabling publication. Token lifetime is not guaranteed by this package.
- Railway compute/storage/PostgreSQL and any external AI provider can cost money. **Ad spend is always 0 EUR**, but that does not mean hosting is free. Default implementation makes no external AI-model calls.

### Integrate in existing CommonJS server.js

Copy the folder with its own `package.json` so module files remain ESM. In an existing async startup function, before app.listen:

```js
const {Pool} = require('pg');
const {attachMarketing} = await import('./homestro-marketing-pilot/modules/index.js');
const {createShopifyClient} = await import('./homestro-marketing-pilot/modules/shopify.js');
const {config} = await import('./homestro-marketing-pilot/modules/core.js');
const pool = new Pool({connectionString: process.env.DATABASE_URL,
  max: 5, connectionTimeoutMillis: 10000, query_timeout: 15000});
pool.on('error', () => console.warn('[organic-pilot] database connection error'));

let pilot;
try {
  const graphql = createShopifyClient({
    domain: process.env.SHOPIFY_STORE_DOMAIN,
    token: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  });
  pilot = await attachMarketing(app, {pool, graphql, cfg: config()});
} catch {
  console.warn('[organic-pilot] initialization disabled');
}

// AFTER the existing Shopify/DSers product transaction succeeds:
// This is an optional immediate trigger; the periodic catalog scanner also discovers products.
void pilot?.processProduct(shopifyProductId).catch(() => {
  console.warn('[organic-pilot] isolated product marketing failure');
});
```

Run `processProduct` with a Shopify Product GID, not a DSers SKU. Never wait for Meta publishing inside the product ingestion transaction. Existing startup authentication middleware may require you to explicitly mount the public feed/assets before its global auth guard. Do not expose approval endpoints without their Bearer auth.

## Localization bridge and reviewed facts

No translation quality is magically guaranteed. Human approval applies to the actual final post. With no external model configured, supply reviewed native German `germanCopy` and facts via the inputs route. Missing copy is visibly `pending_marketing`, not fabricated English content called German.

To reuse the existing Homestro AI localization engine, pass `localizer: async source => { ... }` to attachMarketing. It must return the same shape as `germanCopy` below. Cap that engine's token budget, set request timeouts and validate its provider response there. Do not enable an unbudgeted provider. The adapter must only use provided facts; matching fact IDs is a structural check, not proof that AI claims are factually correct.

Example reviewed inputs (store them securely; fixture is illustrative, not a real supplier record):

```json
{
  "supplierReference": "VERIFIED-SUPPLIER-ID",
  "landedCost": 15,
  "priceReviewed": true,
  "rightsVerified": true,
  "contentReviewed": true,
  "categoryKey": "kitchen",
  "unbranded": true,
  "productType": "Haushalt > Küche > Aufbewahrung",
  "facts": [
    {"id":"f1","text":"Vier Boxen im Set"},
    {"id":"f2","text":"Transparent"},
    {"id":"f3","text":"Für den Kühlschrank"}
  ],
  "germanCopy": {
    "language":"de",
    "title":"Kühlschrank-Organizer im 4er-Set",
    "description":"Vier transparente Boxen für mehr Übersicht in deinem Kühlschrank.",
    "hook":"Mehr Übersicht in deinem Kühlschrank",
    "searchTitle":"Kühlschrank-Organizer 4er-Set für übersichtliche Aufbewahrung",
    "seoTitle":"Kühlschrank-Organizer 4er-Set | Homestro",
    "seoDescription":"Entdecke vier transparente Aufbewahrungsboxen bei Homestro.",
    "benefits":[
      {"factId":"f1","text":"Vier Boxen im Set"},
      {"factId":"f2","text":"Transparente Ausführung"},
      {"factId":"f3","text":"Für den Kühlschrank"}
    ]
  }
}
```

Do not set `rightsVerified` just because AliSave downloaded footage. Confirm permission to reuse it. Do not claim a branded item is unbranded to avoid GTIN requirements. Missing verified cost can be accepted only with an explicitly reviewed selling price; no automatic cost-based price rewrite happens.

## Review API

All `/api/marketing/v2/*` endpoints require `Authorization: Bearer <PILOT_ADMIN_KEY>`. Keep the key on an administrator's private machine; do not put it into public page JavaScript.

| Method / path | Behavior |
| --- | --- |
| GET `/connection` | Read-only Meta identity check, no post |
| GET `/posts?status=draft_queued` | Full reviewable captions and asset URLs |
| GET `/posts?status=recovery_required` | Saved remote state for manual investigation |
| GET `/pending-products` | First ten unresolved products and reasons |
| PUT `/products/:id/inputs` | Save verified inputs and process product; URL-encode the whole GID |
| POST `/posts/:id/approve` | Body `{"reviewer":"Mirko"}`; approves the exact compiled payload |
| POST `/sync` | Paginated active catalog scan |

Example non-publishing test: enable `PILOT_WORKER_ENABLED=true`, keep `PILOT_PUBLISH_ENABLED=false`, populate one product's reviewed inputs, inspect the two drafts and open their image/video URLs. Only then approve one post and deliberately enable publishing. **No live post was sent while generating/testing this package.**

An automatic approval is a request to publish once the enabled worker runs. Do not enable autonomy if a draft should remain a preview. There is no public/admin shortcut to mark a draft published.

## Google feed / delivery

URL: `/feeds/google-organic-v2.xml` (new route; leave the existing working feed untouched until staged validation).

Feed titles use `localized.searchTitle`; do not add made-up capacities such as 20000mAh. Only verified GTIN checksums are emitted. `identifier_exists=no` requires explicit `unbranded=true`. Prices/stock are freshly checked against Shopify. Changed products are reprocessed; failures are omitted from the response rather than emitting a known stale price.

Default shipping is Germany 6.99 EUR and free from an individual product price of 50 EUR. Basket-based free shipping on combinations of cheaper products must ALSO be configured as a matching threshold in Merchant Center account shipping settings. The product feed alone cannot express every basket rule.

EU shipping of 14.99 EUR has been authorized by the owner, but must also exist in Shopify checkout and the public policy before setting it in `PILOT_SHIPPING_JSON`. Example for Austria once aligned:

`[{"country":"DE","price":6.99,"freeFrom":50},{"country":"AT","price":14.99}]`

Extend the array only with real enabled destinations. Do not include GB/CH under EU rates. Merchant data source countries must match actual shipping coverage. The existing Merchant Center account's Misrepresentation block requires shop-policy corrections and Google's review separately.

## Operational limits / unfinished external work

- Tested transport uses mocked Meta responses: platform permissions, current carousel behavior, real publication and failure recovery need one owner-approved staging pilot.
- PostgreSQL schema/locking and migrations need a real database smoke test; no live DB credential was used here.
- Callbacks may run localization; price changes can generate a new draft and invalidate approval. Human approval is intentional, so this is automatic preparation/distribution of approved assets, not blind publication of every product.
- No trustworthy high-volume hashtag claim or reach guarantee is made. Category hashtags are deterministic. Location is null: misleading metropolitan tags are not used. A real verified location can be added as a separately reviewed feature.
- Instagram caption links are not clickable. Set up the Homestro profile link/landing page; Facebook captions carry the tracked URL directly.
- Cache asset files on the persistent volume. Retain files while Meta may fetch them. Add monitored retention cleanup for superseded assets after a suitable interval; this package intentionally does not delete public assets automatically.
- Signed Shopify webhook endpoint is not included: hook into the existing trusted ingestion pipeline as shown, or register verified webhooks in that pipeline. The scanner refreshes every 15 minutes and feed requests recheck freshness.
- Timeout/uncertain writes pause the affected job for manual reconciliation. Do not promise exactly-once publication over remote APIs.

## Validation

`npm test` runs offline unit/contract tests for missing costs, missing suppliers, media priority, carousel selection, organic endpoint allowlisting, approvals, mocked FB/IG flows, uncertain writes, feed correctness, and pagination. These do not prove live platform readiness.

Official implementation references:
- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/product
- https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api
- https://www.postman.com/meta/instagram/overview
- https://developers.facebook.com/docs/graph-api/reference/page/photos/
- https://developers.google.com/merchant/api/guides/products/add-manage

