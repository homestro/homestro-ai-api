# Homestro SEO/GEO theme revision

Live source:197365531006. Prepared Shopify draft:198462833022, UNPUBLISHED, Homestro SEO GEO preview 2026-10-25.

`layout/theme.liquid` is the proposed exact layout; `backup/theme.liquid` is the original read from the live theme. Only addition is a product-page conditional script using Shopify's native `product | structured_data` filter. Existing design, Tapita metadata include, canonical and SEO output remain intact. Current inspected theme has no native Product structured-data block; readback confirms the draft contains exactlyone. Native filter can return ProductGroup; Pilot diagnostics recognizes both Product and ProductGroup.

The Shopify mutation accepted the file without userErrors and its exact stored text was independently read back. This establishes stored draft code, not rendered preview, Google validation or AI-search inclusion. Rendered preview fetch was unavailable. Review the draft preview, then use Publish in Shopify Themes if it behaves correctly. Connector policy blocks publishing a theme or writing the MAIN theme; no bypass attempted. If other theme/app changes are made after this copy, merge/recheck them before publication. Do not overwrite the current live theme blindly with an old copy.

SEO product-field writer is separately deployed on Railway and only fills missing SEO title/description, preserves existing fields and backs up original values. This draft's publication is needed for the theme-level product schema to become live.

Official filter reference: https://shopify.dev/docs/api/liquid/filters/structured_data
