# MS Handwerk Google Business Profile publishing

The Google publisher is separate from Homestro's Meta product publisher. It only posts
German updates for MS Handwerk & Service and never creates Google or Meta ads.

## Behavior

- The owner connects the Google account once at `/ms-handwerk-google-connect`.
- The OAuth refresh credential is encrypted in PostgreSQL. Access tokens and secrets
  are never returned by status endpoints or logged.
- The owner submits a completed job's service, city and factual German description on
  the same page. The Pilot composes the post from those facts and queues it.
- With autopublishing enabled, the worker submits at most one queued post in any
  rolling 24-hour window. It checks the Google API result before marking a post live.
- An uncertain remote write is held for recovery and is never resent automatically.
- No project facts or customer results are invented. Do not include customer names,
  addresses or private details. The template omits unverified promises about price,
  availability and free inspections.

## Google Cloud setup

Google requires an API project with Business Profile API access. The profile must be
verified, active for at least 60 days, and list the business website. Google reviews
API access requests; the code cannot bypass that approval.

Set these values only on Railway service `homestro-ai-api-fixed-current`:

- `GOOGLE_BUSINESS_CLIENT_ID`
- `GOOGLE_BUSINESS_CLIENT_SECRET` (secret)
- `GOOGLE_BUSINESS_REDIRECT_URI` =
  `https://homestro-ai-api-fixed-current-production.up.railway.app/auth/google/business/callback`
- `GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY` (secret; 32 random bytes as 64 hex characters)
- `GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED=false` during connection checks
- `GOOGLE_BUSINESS_MAX_DAILY_POSTS=1`

Generate the encryption key privately with:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

Configure the exact callback URL in the Google OAuth client. After API access is
granted and the account owner authorizes the connection, open
`/ms-handwerk-google-connect`, enter the existing Pilot admin key, connect Google,
load the accessible locations, select the verified MS Handwerk & Service profile,
and use the status/check actions. Enable auto publishing only after the status says
the connection and location are ready. A fixed `GOOGLE_BUSINESS_LOCATION` path can
be supplied instead if an owner-managed Railway configuration is preferred.

## Operations

- Authenticated queue endpoint: `POST /api/ms-handwerk/organic/google/queue`.
  The web page sends service, city and a completed project's German description.
- Read Google connection status: `GET /api/ms-handwerk/organic/google/status`.
- Read combined MS pilot readiness: `GET /api/ms-handwerk/organic/status`.
- Check OAuth and Business Profile access without publishing:
  `GET /api/ms-handwerk/organic/google/check`.
- Read queue/history: `GET /api/ms-handwerk/organic/google/posts`.

All API endpoints above require the existing Bearer Pilot admin key. Public posting
is gated by `GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED`; the default is off. Meta settings
and Homestro content are not changed by this connector.

## Validation limits

Unit tests mock OAuth storage and the Google API response. They do not prove that
Google approved the Cloud project, that the account owner authorized the right
profile, or that Google displays a post publicly. Verify the final post in the
Business Profile before declaring live publication.
