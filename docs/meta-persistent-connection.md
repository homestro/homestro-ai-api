# Persistent Facebook and Instagram connection

Homestro previously read a manually copied `META_PAGE_ACCESS_TOKEN`. This adds an authenticated setup page at `/connect/meta` and server-side OAuth, deriving a long-lived Page token from a long-lived user token and storing only the Page credential encrypted in PostgreSQL. Both the legacy publisher and Pilot v2 consume the stored connection. No paid ads endpoints are used.

## Required configuration

Set these on **homestro-ai-api-fixed-current**, using the Meta application that owns the approved Page/Instagram permissions:

- `META_APP_ID`: that application's numeric ID.
- `META_APP_SECRET`: the same application's secret (private Railway variable).
- `META_TOKEN_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hexadecimal characters. Keep stable across deployments and back it up securely; changing it makes saved credentials unreadable. Generate with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` in a private environment, never a public chat/log.
- `META_OAUTH_REDIRECT_URI`: `https://homestro-ai-api-fixed-current-production.up.railway.app/auth/meta/callback`.
- Existing `DATABASE_URL`, `META_PAGE_ID`, `META_INSTAGRAM_ACCOUNT_ID`, `HOMESTRO_API_KEY`.
- Optional `META_GRAPH_VERSION` (default `v26.0`, matching the existing runtime).

Configure the exact HTTPS callback in the app's valid OAuth redirect URIs and configure `/auth/meta/deauthorize` as its deauthorization callback. The operator must have content creation tasks for the selected Page. Facebook Login must grant `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, and `instagram_content_publish`. The code validates grants and both configured account IDs before committing credentials. App mode, review requirements and account eligibility still need to be validated with the actual Meta app.

Before the first OAuth connection, fully unconfigured installations retain the existing environment token. Partial OAuth configuration fails closed. After a managed connection is invalidated or expires, its publisher never falls back to the old environment token.

## Operator flow

Open `/connect/meta`, authenticate with the existing Homestro administrator key (held only in memory), click connect, and authorize the Page and linked professional Instagram. The server exchanges the code, extends the user token, obtains the Page token, verifies its application, permissions, validity and selected accounts, and stores it. The browser never receives a Meta token. Successful login does not enable publishing or approve queued posts.

`GET /api/connections/meta` gives safe status and dates. `POST /api/connections/meta/check` checks access without publishing. Both require the existing Bearer administrator key. `POST /api/connections/meta/start` binds a 10-minute, single-use state to a Secure HttpOnly SameSite=Lax browser cookie. `/auth/meta/callback` consumes that state atomically in PostgreSQL. Status never returns ciphertext or tokens.

Checks run every 6 hours while the process is alive. Expiry/data-access deadlines are checked before every credential use. A token rejection marks the matching stored revision as needing reauthorization, so an older request cannot invalidate a newly connected token. Temporary API/network failures retain the usable connection and report a degraded check. Deauthorization callbacks require the app's HMAC signature and matching user.

## Lifetime and limits

This uses Meta's token exchange and Page token derivation, **not an invented refresh-token grant**. A zero expiration returned by Meta means no scheduled token expiry; it does not mean access can never be revoked. Data-access expiry, password/security events, loss of Page role, removed permissions or app deauthorization may require the owner to click Connect again. No token copying is needed for that reauthorization. Dates come from `debug_token`, not assumptions.

After deployment, verify OAuth against the actual app, confirm `/api/connections/meta` is connected after a restart, and check both Meta account IDs. Then separately review a concrete organic draft and verify a real Facebook and Instagram publication. This change does not prove live publishing or Google Merchant approval.

## Validation

16 new mocked flow and route tests cover token exchange and derivation, encrypted persistence/restart, browser-bound single-use state, cancellation, app/permission/account mismatch, expiry, revocation, network failures, encryption tampering, partial setup and both publisher integrations. The broader run before the additional route test had 51/52 passing; the existing `missing supplier reference counts as processed and persists pending` test fails unchanged on the original baseline because ingestion now attempts preview rendering. No ingestion code is modified here. Syntax checks passed for all changed JavaScript files. The setup page has not yet been exercised against a live Meta app.

Official implementation references (retrieval returned HTTP 429 during this task):

- https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
- https://developers.facebook.com/docs/pages-api/getting-started/
