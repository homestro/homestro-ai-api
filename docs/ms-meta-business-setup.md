# MS Handwerk Meta publishing

This is a separate organic connector for the MS Handwerk & Service Facebook Page and its linked professional Instagram account. It does not reuse Homestro's page credentials and does not create ads.

## One-time setup

Set on Railway service `homestro-ai-api-fixed-current`:

- `META_MS_OAUTH_REDIRECT_URI=https://homestro-ai-api-fixed-current-production.up.railway.app/auth/meta/ms/callback`
- `MS_META_AUTOPUBLISH_ENABLED=false` until connection and posting are checked
- `MS_META_MAX_DAILY_PER_CHANNEL=1`

The existing Meta app ID, app secret and token encryption key are shared app configuration only; MS page tokens are stored encrypted in a separate MS-specific row. Add the exact callback URL above in the Meta app. The Meta app needs `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic` and `instagram_content_publish`. The person connecting must manage the exact page named MS Handwerk & Service and grant content creation. Instagram requires a professional account linked to that page.

Open `/ms-handwerk-meta-connect`, enter the existing Pilot admin key and choose **Připojit Meta**. Sign in to the account that manages MS's page and approve access. The callback checks the exact page name and granted tasks. It never selects or falls back to Homestro.

## Queue and publishing

Enter a real completed job's service, city and factual German description. Facebook can publish the text and a link to the MS website. Instagram is queued only if a linked Instagram account and a public photo URL hosted at `ms-handwerkservice.de` are supplied. The worker processes at most one post per channel per rolling 24-hour window. Ambiguous publishing results are held for recovery, not resent automatically.

The pilot does not invent completed jobs or customer facts. Queueing is not proof of publication; check `/api/ms-handwerk/organic/meta/posts` for published status and a permalink. Status endpoints never return access tokens. Set auto-publishing true only after checking account connection and a test post. Paid ads remain disabled and spend remains 0 EUR.

## Operational endpoints

- `POST /api/ms-handwerk/organic/meta/connect` starts owner OAuth.
- `GET /api/ms-handwerk/organic/meta/status` reports connection and queue state.
- `POST /api/ms-handwerk/organic/meta/queue` queues a completed-job post.
- `GET /api/ms-handwerk/organic/meta/posts` returns recent statuses.

All four API endpoints use the existing Pilot Bearer admin key. Meta app approval and owner consent are platform actions; deployment alone does not connect an account or publish a post.
