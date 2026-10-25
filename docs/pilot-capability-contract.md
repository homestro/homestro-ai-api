# Homestro Demon — capability contract

Updated 2026-10-25. This defines comparable outcomes, not access to vendors' private code or a claim of complete parity. Implemented code, enabled runtime, actual delivery and profitable sales are different evidence levels.

## Reference scope

Public vendor descriptions inspected on 25 October 2026:

- Tanganica: https://help.tanganica.com/de/articles/12384226-was-ist-tanganica-com and https://www.tanganica.com/en — Meta, Google and Bing advertising; creative generation; analytics; store diagnostics; social content; newsletters and support.
- Christiani: https://jetzt-testen.christiani.ai/ and https://jetzt-testen.christiani.ai/live-demo — business knowledge, positioning, storytelling and personalized posts, ads, funnels and emails.
- Expoya: https://www.expoya.com/ — topic research, landing pages, social content and search visibility.
- Crush: https://trycrush.ai/ — Meta creative, testing, audience selection, performance optimization, competitor library and social posting.

Marketing descriptions do not establish these products' internal algorithms, API availability or guaranteed results.

## Current contract and acceptance evidence

| Capability | Pilot implementation | Evidence needed to mark complete |
|---|---|---|
| Shopify catalog | Existing feed diagnosis, availability, EUR, image/link checks; variant cost sync | Successful recent feed and complete cost snapshot; last observation: 384 products, 1461 variant costs |
| Cost-aware product selection | Fresh known costs; configured price/headroom policy; category diversity and least-explored memory | Product-selection audit with actual eligible/rejected counts; no claim that headroom is net profit |
| Meta acquisition | Existing single campaign/adset/ad, DE/AT, website carousel, bounded test | Meta identity/status and reporting; ACTIVE alone is not delivery |
| Autonomous experiment control | Persistent intent, create/attach reconciliation, one rotation per 24h after additional exposure spend | Confirmed same-ad attachment; no duplicate ad, no budget/end-date change |
| Performance and stopping | Actual Insights, canonical purchases/ROAS, durable stops, independent watchdog | Provider reads and pause confirmation; missing data never implies purchases |
| Attribution/economics | Signed link reference, signed paid/refund/cancel webhooks, immutable known COGS, confirmed expenses | Genuine attributed paid order, complete actual costs and reported spend; currently no verified profitability |
| German copy | Three neutral deterministic message templates | Real feed facts; a complete brand-knowledge/storytelling generator remains missing |
| Store diagnostics | Read-only sample of homepage and up to three product pages; HTTP, metadata, H1, canonical, alt and JSON-LD checks | Recorded sampled URLs/issues; no claim of full SEO audit, rankings or Core Web Vitals |
| Organic social | Separate existing main-service publisher | Platform receipts/URLs per brand/channel; historical service records do not prove current publication |
| Competitor trends | Existing Meta archive adapter and matching, failure reported explicitly | Authorized source response; current source rejection is not trend data; 14-day longevity does not prove profit |
| Higgsfield imports | Existing integration scaffolding; observed completed Ads Studio runs without downloadable output URLs | Actual accessible export/job URLs, persisted downloads and queue receipts; no generation claimed |
| Generative ads in 9:16 and 1:1 | Existing creative-factory scaffolding, paid generation disabled | Approved cost plus actual outputs, aspect validation and publishing receipts |
| Google/Bing advertising | Not complete for this Pilot | Valid account connector, campaign identity, dry-run preview, conversion and budget controls, authorized live activation |
| Cross-channel budget allocation | Not implemented | Reliable common attribution/cost basis, channel-specific safeguards, explicit total budget; never scale current EUR5 test by inference |
| Brand knowledge and campaign strategy | Not complete | Versioned real business facts, factual-claim validation, generated strategy/copy tests and provider integration |
| Email/newsletter/customer support | Not implemented as a live channel | Store consent/suppression inputs, delivery connector, reviewed recipient scope, unsubscribe handling and actual delivery evidence |
| SEO content and landing-page creation | Diagnostics only; automatic authoring/publication missing | Brand-safe factual drafts, own-store publishing integration, preview/rollback and duplicate protection |
| Full reporting/learning | Protected /pilot/brain and /pilot/economics; source freshness and explicit gaps | Actual experiments/orders over time; no invented learning from unobserved outcomes |

## Fixed operating boundary

Current authorization is the existing EUR5/day, seven-day Meta test, EUR35 reported-spend stop, plus stop after over EUR15 without reported purchases unless valid signed payment evidence supports holding. A provider's daily budget is not an exact hard real-time spending ceiling; polling and reporting delay remain. No other paid campaigns/channels, new subscription or paid AI generation is enabled by this contract.

The measurement waiver is explicit and separate from verification: `META_PURCHASE_EVENT_VERIFIED` remains false. No prior sale is required for the bounded acquisition test. Refunds, cancelled/test/sample orders and stale costs cannot become profit evidence.

## Remaining implementation order

1. Confirm live selection/diagnostic evidence and current ad delivery, then collect genuine experiment/order evidence.
2. Add versioned business facts and grounded German creative/strategy drafts with a provider adapter; keep paid calls off until costs are authorized.
3. Complete real media import from accessible existing exports; validate formats and deduplicate before publishing.
4. Add store content/landing-page draft and revision workflow, then organic-channel receipts and scheduling by brand.
5. Implement email drafts and consent-aware delivery integration; connect Google/Bing with read-only diagnosis before any authorized paid launch.
6. Build common reporting and conservative allocation only after channel attribution and actual cost completeness are established.

Do not label this contract or the current bounded Meta buyer as a completed replacement for all four services. Every missing row must gain executable integration, meaningful tests and the stated live evidence before its status changes.
