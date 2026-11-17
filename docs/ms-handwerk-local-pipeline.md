# MS Handwerk local marketing pipeline

This isolated pipeline creates one German local content bundle per Berlin calendar day. It does not read Shopify or Homestro product data and does not use paid AI APIs or ad endpoints. The Python builder creates local SEO/GEO text, a copy-ready Kleinanzeigen ad and Google Business Profile post, and a 9:16 FFmpeg Ken Burns clip. It uses up to five files from `assets/ms_handwerk/`; when empty, it creates branded text cards locally. Generated files and idempotency state are stored under `/data/ms_handwerk` on the existing Railway volume.

The workforce status endpoint is `GET /api/jarvis/v1/workforce`; the daily bundle appears under `msHandwerkPipeline.lastCycle.bundle`. The authenticated one-time generator is `POST /api/jarvis/v1/workforce/ms-handwerk/run`. Video assets are served only from the fixed `/ms-handwerk-assets/<generated-name>.mp4` route. The automatic daily runner starts only when `MS_HANDWERK_PIPELINE_ENABLED=true`.

## Railway settings

Set on `homestro-ai-api-fixed-current` in production:

- `MS_HANDWERK_PIPELINE_ENABLED=true`
- `PAID_ADS_ENABLED=false`
- `MS_ZERNIO_FB_ACCOUNT_ID` — exact MS Handwerk Facebook account ID from Zernio
- `MS_ZERNIO_IG_ACCOUNT_ID` — exact MS Handwerk Instagram account ID from Zernio
- `MS_ZERNIO_TIKTOK_ACCOUNT_ID` — exact MS Handwerk TikTok account ID from Zernio
- `MS_ZERNIO_TIKTOK_PUBLISH_CONSENT=true` only when the owner authorizes public commercial posting for the MS TikTok profile

`ZERNIO_API_KEY` already exists on the service and is shared provider authentication; the new code only submits to the exact `MS_ZERNIO_*` account IDs and verifies each ID's platform and active state before posting. It never falls back to Homestro account IDs. The existing `ZERNIO_TIKTOK_ACCOUNT_ID` is not read by this MS pipeline. An account without an ID is skipped. TikTok also requires the explicit MS consent flag and a successful provider preflight.

Paid advertising is not implemented in this module. Publishing is organic only, and uncertain provider outcomes are durably held so the daily cycle does not resend them.
