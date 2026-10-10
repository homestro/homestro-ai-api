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
confirm the displayed media/caption and consent to publication. There is no
automatic TikTok consent. Approvals are tied to the Shopify product revision.
Pinterest uses existing reviewed-organic autonomy if that policy is enabled;
otherwise approve each Pinterest draft in the same page.

Once the two accounts and drafts are verified, set PILOT_SOCIAL_PUBLISH_ENABLED=true.
New publication is limited to one product per channel in a rolling 24-hour window,
inside 09:00–22:00 Europe/Berlin. Both channels together add at most two daily
posts, independently of existing Meta quotas. Already published products are not
repeated automatically; schedule a new campaign explicitly if repetition is wanted.

Do not declare success until a public TikTok/Pinterest permalink is present in
GET /api/marketing/v2/social/posts?status=published and checked on the platform.
An accepted response with a missing URL stays remote_pending. A Creator Inbox
draft, HTTP 207 platform failure, unknown POST result, or mismatch never counts as
public publication. Restart recovery reconciles stored remote IDs by GET only;
uncertain writes without a provider ID require investigation, not a blind retry.
An unresolved job conservatively holds that channel's quota.

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
