# Homestro autopilot completion gate

A Shopify DRAFT must never be reported as complete merely because the processing function ran.

Required before `homestro-ai-complete`:
- German customer-facing title; no supplier/source boilerplate.
- German sales description; remove source-data diagnostics such as `Quelldaten`, `Electronic: No`, `Power Supply: None`, `Is Batteries Included: No`, `Mainland China` unless genuinely customer-relevant.
- Variant option/value normalization: supplier values such as `A/B/C`, `HOT-MASSAGE`, `Hot-Massage C`, `HOT-MASSAGE-TRACTION`, `As picture`, etc. must be mapped to meaningful German customer-facing values. If a variant cannot be interpreted safely, keep product pending/rejected instead of complete.
- Variant price must be calculated only after matching the correct variant cost. Never lower existing price; enforce configured minimum net-profit rules.
- Correct German product type/category/tags.
- SEO title and description present.
- Existing valid images must not be deleted. Images with obvious supplier/English/Chinese promotional text must keep image QA pending until fixed.
- `homestro-ai-rejected`, `homestro-profit-pending`, or active image QA pending must block complete.
- ACTIVE Shopify products must never be modified by the DRAFT autopilot.

Regression test product observed 2026-10-01: Shopify product 16104465301886, `Nackenmassagekissen PAQIN – laut Herstellerangaben für die Halsregion`. It showed bad variant values and source-data boilerplate after a run logged as processed. Use this as the first acceptance test. `processed` means attempted; `complete` means all gates passed.