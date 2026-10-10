# Homestro social connector

This connector reuses existing ready Shopify product documents, German copy and
cached JPEG/MP4 assets. It adds no model call, ad campaign or paid video service.
Existing Railway hosting and existing OpenAI localization still have their own costs.

## Owner connection

1. Open https://zernio.com and create/sign into the owner's free account.
2. Connect exactly Homestro TikTok and Pinterest; do not add a card or a third account.
   The provider currently includes two connected accounts. Check pricing before setup.
3. Finish TikTok/Pinterest OAuth as the owner. Prefer the current TikTok Business
   connection rather than the legacy developer connection with app-wide capacity limits.
4. Create/select the Homestro Pinterest board. Generate the provider API key.
5. Save the key directly as a Railway service secret, never in chat or in GitHub.
   Resolve account IDs through authenticated GET /api/v1/accounts and board ID through
   GET /api/v1/accounts/{accountId}/pinterest-boards.

Railway variables (no secret values belong in this document):

- PILOT_SOCIAL_ENABLED=true
- PILOT_SOCIAL_PUBLISH_ENABLED=false during setup
- ZERNIO_API_KEY: secret
- ZERNIO_TIKTOK_ACCOUNT_ID: provider's 24-character account ID
- ZERNIO_PINTEREST_ACCOUNT_ID: provider's 24-character account ID
- ZERNIO_PINTEREST_BOARD_ID: owner's board ID

The existing PILOT_WORKER_ENABLED and PILOT_PUBLISH_ENABLED also gate new writes.
Missing/invalid social configuration disables this connector independently of Meta.
Default is off. It uses the existing database and volume, not a new service.

## Validation and activation

After deploying this change, use the existing pilot authentication for:

- GET /api/marketing/v2/social/status
- GET /api/marketing/v2/social/connection
- POST /api/marketing/v2/social/prepare
- GET /api/marketing/v2/social/posts?status=draft_queued

Open /marketing-social-review and authenticate with the existing pilot key.
Preview each TikTok draft and explicitly choose public visibility/interactions,
confirm the displayed media/caption and consent to publication. The batch composer
can select all currently displayed TikTok drafts, apply explicitly chosen common
settings and confirm preview/consent once for that exact selection. It sends
individual revision-bound approval requests with progress and partial failures.
Changing the selection clears the previous consent; future drafts are not included.
There is no
automatic TikTok consent. Approvals are tied to the Shopify product revision.
Pinterest uses existing reviewed-organic autonomy if that policy is enabled;
otherwise approve each Pinterest draft in the same page.

Once the two accounts and drafts are verified, set PILOT_SOCIAL_PUBLISH_ENABLED=true.
The legacy default remains one product per social channel in a rolling 24-hour
window, inside 09:00–22:00 Europe/Berlin. Historical owner request: four-hour cadence on
10 October 2026. Configure PILOT_PUBLISH_EVERY_HOURS=4,
PILOT_PUBLISH_AROUND_CLOCK=true, PILOT_MAX_DAILY_PER_CHANNEL=6,
PILOT_MAX_DAILY_POSTS=12 and PILOT_PUBLISH_ONCE=false. Meta has its separate
12-post total cap across Facebook/Instagram. TikTok/Pinterest each have a six-post
rolling daily cap. Database timestamps enforce a four-hour minimum per channel,
including after restart. Eligible approved stock and provider acceptance are
required; no missed slot produces a burst of catch-up posts. Already published products are not
repeated automatically; schedule a new campaign explicitly if repetition is wanted.

Do not declare success until a public TikTok/Pinterest permalink is present in
GET /api/marketing/v2/social/posts?status=published and checked on the platform.
An accepted response with a missing URL stays remote_pending. A Creator Inbox
draft, HTTP 207 platform failure, unknown POST result, or mismatch never counts as
public publication. Restart recovery reconciles stored remote IDs by GET only;
uncertain writes without a provider ID require investigation, not a blind retry.
An unresolved job conservatively consumes one quota entry until reconciled.

Setting PILOT_SOCIAL_PUBLISH_ENABLED=false stops new writes while allowing read-only
verification on worker ticks. Set PILOT_SOCIAL_ENABLED=false to disable the whole
connector. No credentials are returned by status or persisted in post payloads.

## Verification

Run: node --test homestro-marketing-pilot/test/*.test.js

Local tests cover actual FFmpeg JPEG/MP4 creation, existing Meta behavior, consent,
changed/out-of-stock/rejected sources, duplicate guards, daily quotas, accepted
responses without permalinks, crash reconciliation and ambiguous POST outcomes.
Provider credentials/OAuth, real PostgreSQL migration and public platform posting
must still be validated in the deployed environment; mocked tests do not prove those.

Official references:

- https://zernio.com/pricing
- https://docs.zernio.com/platforms/tiktok
- https://docs.zernio.com/platforms/pinterest
- https://docs.zernio.com/posts/create-post


## Current owner policy — 10 October 2026, after official-policy research

PILOT_ORGANIC_POLICY=balanced-v1 supersedes the historical all-channel four-hour
configuration above. It normalizes Meta configuration to an eight-hour minimum,
two posts per channel per rolling 24 hours and four total Meta posts. TikTok uses
four-hour spacing with four attempts per rolling 24 hours; Pinterest uses two-hour
spacing with six attempts. All new publishing runs only 09:00–22:00 Europe/Berlin
(DST-aware). These are maximums, not promised delivery counts or platform limits;
missing approvals, stock changes, old quota entries and unresolved writes reduce
actual publishing. There is no catch-up burst. Use PILOT_PUBLISH_EVERY_HOURS=8,
PILOT_PUBLISH_AROUND_CLOCK=false, PILOT_MAX_DAILY_PER_CHANNEL=2,
PILOT_MAX_DAILY_POSTS=4 alongside the policy for explicit operational clarity.

Before remote submission, both queues reject exactly repeated media references
on the same channel within 30 days, including across different product IDs, using
REPEATED_MEDIA. Images are compared as sorted sets; a matching video URL also
counts. This is not perceptual duplicate detection: visually similar files at
other URLs or re-rendered videos can differ. Existing product/history guards and
uncertain-write holds remain. TikTok per-post/batch preview and consent are unchanged.
The review status returns channelPolicies and the UI shows these distinct caps.

Pinterest descriptions retain full factual sentences, price and shipping note;
the product URL is in its dedicated destination field rather than repeated in the
description. If necessary, trailing benefit sentences are omitted to fit 800
characters; claims are never truncated into new meanings. Newly changed drafts
receive new revisions; previously approved TikTok drafts are not altered by this
Pinterest-only change. No AI, ads, paid music or additional account is added.

Official policy references consulted:
- https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/
- https://about.fb.com/news/2025/04/cracking-down-spammy-content-facebook/
- https://about.fb.com/ltam/news/2024/05/ayudando-a-los-creadores-a-encontrar-nuevas-audiencias/
- https://policy.pinterest.com/en/community-guidelines
- https://support.tiktok.com/en/business-and-creator/creator-and-business-accounts/promoting-a-brand-product-or-service

Validation: 108/108 marketing tests pass, including differentiated caps/gaps,
night exclusion, exact-media suppression before Meta preflight, explicit-ID channel
caps, Pinterest long-copy preservation and unchanged TikTok batch-consent tests.
No guarantee of recommendation eligibility, reach or sales is implied.

Queue selection now reserves up to 20 approved candidates per channel so a large
TikTok batch cannot starve Pinterest when TikTok is capped. First balanced release
2e2556ec848b47c851e3f0bad60d687533e565bb reached Railway SUCCESS on deployment
a2c65129-59a6-424d-b220-e119bc85f125. Final fairness patch needs its own deployment
verification; no new public TikTok/Pinterest post is asserted by this change.
