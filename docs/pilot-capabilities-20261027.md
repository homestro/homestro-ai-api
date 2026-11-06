# Pilot capability matrix — 27 October 2026

This describes our required outcomes inspired by Tanganica, Expoya, Crush and Christiani. It makes no claim to their internal implementations or complete parity. `implemented` describes executable code; `tested` means local tests with synthetic providers unless explicitly stated otherwise; `provider-blocked` describes the remaining live evidence/access gate. Tests are not sales, platform delivery or real profitability.

## Baseline and preservation

Based on merged PR121 / main `ed465a71c075c1f3b53ef05ae8c4da13174bb143`.
The pre-existing local PR121 edits are preserved in Git stash `preexisting-PR121-preserved` and were not overwritten. They already occur in main. The AdTech code and image configuration are consolidated from existing production branch `deploy/adtech-pilot` commit `73a85d7` (PR120), rather than reimplementing its 80-file evolution. Node publisher code is kept from main, including PR121. No credentials, product/status changes, paid generations or ad activations were performed.

Live inventory read before work: 239 persisted catalog records; 78 prepared / 161 blocked; 11 imported Higgsfield **images**, 0 imported videos, 44 queued draft receipts and 0 confirmed publications among these imports. Higgsfield Ads Studio lists exactly 11 completed existing generation runs. The catalog also has native Shopify footage; it is a different source from those 11 image imports. XML offer counts are not unique product counts.

| Capability | implemented | tested evidence | provider-blocked / practical limit |
|---|---|---|---|
| Whole active/draft/archived catalog and new Shopify offers | Existing paginated sync, persistent CatalogBrain, rotating preparation; no 11-item cap | catalog-brain, preparation, rejection, bridge; >100 records and pagination | Draft/archived items remain analysis-only; no invented automatic supplier acquisition |
| Product selection and new-offer eligibility | Existing cost/demand/stock rules and category diversity from production AdTech | product_selection, ads-sales-plan, website_ads | Unknown landed costs/fees/returns prevent a net-profit claim; external supplier offers still require real source evidence |
| DE/AT content and brand memory | Source-bound German facts, brand versions, content/director tasks | content_engine, brand_memory, cognitive_strategy | Unsupported translations/claims remain blocked; paid reasoning remains off |
| SEO/GEO | Existing metadata/ALT/guide/article writers, revision/handle reconciliation, source-backed structured data | seo-publication/articles/guides, seo_writer, store_diagnostics | GEO unpublished-theme publication and rendered readback remain owner/provider work; indexing/ranking not verified |
| Video scripts/scenarios | New five-second German shot proposals from existing fact IDs in operations report | operations.integration source-fact rejection | Proposals do not prove motion quality or justify replacing an existing clip |
| OpenAI video failure handling | Persistent credential/model-bound circuit; script/speech, HTTP and allowlisted error-code diagnostics; cached/source media fallback | openai-health, media.integration/fallback; auth rejection across restart without another request | Actual configured credential still rejected in latest live logs; no token reset or fabricated root cause; next diagnostic reveals the provider code |
| Asynchronous motion creation | Existing Runway submit intent/poll/recovery; new persisted 30-minute price quote and exact source/cost acceptance; active-source check | generative-video: quote, cost mismatch, task ID, response loss and polling | RUNWAY_API_KEY absent; default opt-in remains off; no paid call in this work |
| Media registry/deduplication | Existing SHA registry and format normalization; reuse native/imported video; reject a second pending task for same revision | imported-media, generated-video-handoff, media_registry, publisher_handoff | 11 existing exports are images; no generated-motion quality confirmation |
| Handoff and persistent calendar | Imported video queue status now includes platform ID and scheduled_for; operations plans actual approved native queues with Berlin windows; both workers respect earliest times | operations.integration: existing video→schedule→Worker→platform ID→daily report/restart | Earliest eligible time is not a platform booking or delivery guarantee; normal quota/connection/source checks still apply |
| FB/IG/TikTok/Pinterest publishing | Existing sole publishers, distinct brand/accounts, current-source review and TikTok consent | worker, social, zernio, social-connection/review | Unreviewed imported images stay drafts; TikTok needs the actual preview/privacy/express-consent settings |
| Platform confirmation and uncertain sends | Existing provider IDs/permalinks, exact identity recovery, immutable first-attempt timestamps | worker/social/zernio, search_write_recovery, operations.integration response loss | Unmatched/ambiguous recovery remains held; no blind resend; stored receipts are labelled as stored evidence |
| Ads preparation/validation | Production Google validateOnly and paused bundle writers; Microsoft paused writer, targeting verification and async reports | google_writer, microsoft_writer/targeting/reports, search_campaigns | Real Ads account credentials/configuration absent; live provider validation unobserved; no activation authorized |
| Pause/scale and common budget | Existing stop-only adapters, durable Meta stop/watchdog, bounded allocation proposal from exact common accounting | channel_control/accounting, purchase_guard, test_spend_stop | Purchase hard lock, 0 current spend authority; no automatic raise/resume; five EUR is a ceiling, not permission |
| Attribution and actual economics | Existing signed channel links, signed paid/refund/cancel webhook, immutable cost evidence and isolated campaign expense scope | order_economics, payment_webhooks, channel_accounting, unified-attribution | Missing actual costs or exact spend windows stay unknown; full total net profit is not asserted |
| Daily evidence report and brain link | New per-Berlin-day Node operational snapshots; bounded authenticated bridge; new persisted AdTech report composed in existing daemon; protected read endpoints | daily_reports actual SQLite restart + mock HTTP; operations.integration | Two services require review/deployment of their respective code; source outages stay explicit/historical, not current success |
| Email/support expansion | Existing consent/suppression/SMTP backend consolidated unchanged | email_delivery synthetic transport | No recipient import/send authorized; real consent, suppression and SMTP identities required for live delivery |

## Operational interfaces

All private paths below use the **existing** administrator/internal credentials. Never copy secrets into a report or repository.

- `GET /api/marketing/v2/providers/openai`: safe persisted diagnostic. Read-only; no paid request.
- `GET /api/marketing/v2/operations?day=YYYY-MM-DD`: latest stored snapshot for that Berlin day. Absence returns `not_observed`.
- `POST /api/marketing/v2/operations/run`: bounded inventory/schedule/report pass; no content generation or publication request.
- `GET /api/marketing/v2/media/imports/:job` (existing route): exact job handoff/readback; approved rows now expose `scheduled_for` and `platform_id`. A null time means it is not scheduled.
- `POST /api/marketing/v2/generated-videos/quote`: source revision and existing video inventory check, estimated USD price (tax excluded) and 30-minute quote; no generation. Reuse responses identify the existing task/job instead.
- Existing `POST /api/marketing/v2/generated-videos`: requires `costApproval={quoteId,approved:true,approvedCostCents:25,currency:"USD",reviewer}` matching the stored unexpired quote, existing opt-in/key and daily cap. Approval is bound to the exact source/prompt request. Paid provider intent is durable before POST. A previous intent is read back without charging again.
- Existing generated task polling/handoff paths preserve separate product-fidelity review and channel consent.
- `GET /pilot/daily-report?day=YYYY-MM-DD`: private persisted combined AdTech evidence report. Includes source timestamps/freshness, exact per-channel cost evidence and explicit unknown total profit; never claims a sale from a click.

The operations timer inventories before making assignments, starts with the existing runtime, ticks every minute and stops with it. It does not publish independently. AdTech's existing unpaid-marketing scheduler reads operations using `PILOT_ORGANIC_API_KEY`, and refreshes its daily evidence report after the existing selection, attribution/accounting, import/handoff and draft passes.

## Narrow owner-only live gates

These do not prevent implementation/tests and are not instructions to rebuild functional Shopify/Railway connections.

1. **OpenAI account / existing OPENAI_API_KEY**: live video code reports OPENAI_AUTH_FAILED; existing value is names-only to the connector. After reviewed deployment, protected diagnostics distinguish script/speech, 401/403, invalid_api_key/insufficient_permissions/etc. Owner fixes only the indicated key/project/model permission privately. Do not blindly replace the key or infer a billing failure.
2. **Runway / RUNWAY_API_KEY**: absent in publisher names inventory. Needed only if choosing this motion provider. `PILOT_GENERATIVE_VIDEO_ENABLED` stays off until one exact quote is accepted; Higgsfield subscription credits are not Runway API credit. No new subscription is required to use already existing videos.
3. **Homestro channel review**: actual SHA/revision-bound visual review for imported creative. TikTok additionally requires actual `tiktokSettings.content_preview_confirmed`, `express_consent_given`, `privacy_level` and interaction choices for that preview. Existing FB/IG and Zernio accounts remain configured; no reauthorization is asserted necessary.
4. **Google Ads account**, for optional live validation: GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_DEVELOPER_TOKEN and either GOOGLE_ADS_ACCESS_TOKEN or GOOGLE_ADS_CLIENT_ID + GOOGLE_ADS_CLIENT_SECRET + GOOGLE_ADS_REFRESH_TOKEN; none were present in the AdTech names inventory. This is separate from Shopify and Merchant Center permissions.
5. **Microsoft Advertising account**, for optional live validation: MICROSOFT_ADS_ACCOUNT_ID, MICROSOFT_ADS_CUSTOMER_ID, MICROSOFT_ADS_DEVELOPER_TOKEN and either MICROSOFT_ADS_ACCESS_TOKEN or MICROSOFT_ADS_CLIENT_ID + MICROSOFT_ADS_CLIENT_SECRET + MICROSOFT_ADS_REFRESH_TOKEN. Country targeting additionally needs verified MICROSOFT_ADS_COUNTRY_LOCATION_IDS_JSON; refresh persistence uses existing configured token-encryption secret. These Ads names were absent in the live inventory.
6. **Store measurement / Shopify paid event**: genuine attributable signed payment and actual costs/spend must establish Purchase evidence before any paid launch; no fake order, artificial paid transaction or new spend was made. Existing SHOPIFY_WEBHOOK_SECRET is present; this is an evidence gate, not a request to redo working installation.
7. **GEO theme publication**, if the owner chooses it: review/publish the already prepared theme change and verify rendered output. No second theme, product or duplicate SEO article is needed.

No SMTP/send approval is needed for organic marketing; email remains an optional disabled channel. No new request for Shopify/Railway access is needed for the code work.

## Validation record

See final dated evidence in `docs/pilot-operating-brief.md`. Runtime deployment, platform publication and real profitability must be recorded separately from local passing tests. No live new generation, social post or order is claimed by this change set.
