# HOMESTRO Shopify DRAFT autopilot

The existing catalog autopilot processes only Shopify products whose current
status is `DRAFT`. A product is tagged `homestro-ai-complete` only after the
post-write readback passes content, SEO, variant, per-variant price/margin,
variant-image, media, collection, and DRAFT-status checks. Failed checks remain
visible in the processing result and use `homestro-ai-qa-pending`.

## Required configuration

- `SHOPIFY_STORE_DOMAIN` plus `SHOPIFY_ACCESS_TOKEN` (or Shopify client
  credentials) with product and collection write access.
- `OPENAI_API_KEY` for German content and strict visual relevance checks.
- Supplier landed costs on **every** Shopify variant. A missing cost is never
  guessed and keeps the product pending.
- `HOMESTRO_COLLECTION_MAP_JSON`, mapping semantic keys to Shopify collection
  GIDs. Supported keys are `haushalt`, `kueche`, `haustiere`, `sport`, `garten`,
  `beauty`, and `elektronik`, for example:

  ```json
  {"kueche":"gid://shopify/Collection/123","haushalt":"gid://shopify/Collection/456"}
  ```

Supplier/API data must provide meaningful variant-image associations. When a
multi-variant product has no image association, QA intentionally leaves it
pending rather than assigning an image by guesswork. Cross-sell continues to
use Shopify's complementary-products metafield and only selects genuinely
related, currently active products; this does not modify those active products.
