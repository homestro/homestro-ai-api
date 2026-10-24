# Homestro AdTech Pilot (Python service)

This is a separate FastAPI service alongside the existing Node/Shopify Pilot. It validates product feeds, runs scheduled diagnostics, creates reviewed creative candidates when explicitly enabled, and records marketing plans. It does not copy Tanganica's private implementation.

## Current safety state

- `PILOT_AD_DRY_RUN=true` and `PILOT_AD_MAX_BUDGET_EUR=0` are the defaults.
- The scheduled Shopify GraphQL catalog check is read-only. Missing scopes, unavailable product costs, API errors, and incomplete pagination fail closed; it never treats unknown cost as a passing margin.
- The daemon starts with the API by default, runs feed and Merchant Center diagnostics every six hours, public Meta Ad Library discovery and creative generation every 24 hours, and reports a heartbeat hourly. Each task has its own bounded retry/backoff; one provider failure does not stop the other tasks.
- GitHub reporting is optional. When `PILOT_GITHUB_TOKEN` is configured, the daemon updates one rolling status comment on PR #104 rather than creating hourly comment spam.
- Google/TikTok/Pinterest/Microsoft/Sklik publishing and optimizer mutations are not wired in. `/feed/prepare/*` creates normalized payloads only; it never uploads them.
- The execution engine refuses all writes in dry-run, verifies the reconciled portfolio total before checking the cap, and fails closed if a platform adapter is missing. Cross-platform transfers remain recommendations because two ad networks cannot provide one atomic budget transaction.
- Autopilot scheduling is disabled unless a trusted metrics loader is injected and `PILOT_AUTOPILOT_ENABLED=true` is set. Attribution and contribution margin must be verified before scaling or moving budgets.
- Creative generation remains blocked until a trusted source supplies fresh, verified per-product intent; the daemon never selects the first product from the feed or incurs image-generation charges without that evidence. The isolated Meta publisher also requires a matching eligible intent rank and blocks before any Meta API request when intent is missing or mismatched. Product-intent ingestion is not connected yet, so no campaign can be submitted through the daemon.
- Merchant Center uses the official Merchant API v1 for read-only account/product diagnostics when `GMC_MERCHANT_ID` and a service account JSON secret are configured. It never rewrites or uploads products. Product claims are not inferred from LLM output, and account policy issues such as misrepresentation or shipping configuration require a verified human/business correction.
- `ALLOW_MICRO_BUDGET` is false by default. The isolated Meta publisher can submit exactly one DE/AT website-sales campaign only after the account, Page and Pixel pass official API checks; billing and standard Purchase-event tracking are explicitly verified; the configured feed product and approved creative match; EU beneficiary/payer values are supplied; and `DRY_RUN=false`. A prior sale is not required, but an accessible Pixel alone is insufficient: set `META_PURCHASE_EVENT_VERIFIED=true` only after a real test event has been confirmed in Meta Events Manager. The campaign optimizes for Meta's standard Purchase event, uses a **€5 lifetime budget over seven days**, and leaves placements to Meta Advantage+ by omitting fixed placement restrictions. It permanently consumes a single-use SQLite claim before any write. Campaign, ad set and ad are created paused; the campaign is activated last. If a previous HTTP failure consumed the local one-shot claim without returning a campaign ID, the publisher checks Meta read-only for the exact campaign name before it releases that claim and retries; an existing or ambiguous campaign stays blocked. The global optimizer remains dry-run/€0.
- The Meta competitor connector uses only Meta's public Ad Library API. Access is account/app-dependent. Its data shows ad examples and structure, not competitor ROAS, conversions or profit. There is no scraping fallback.

## Modules

- `feed_manager.py`: bounded JSON/XML parsing, GTIN/EAN check digit, canonical product URL, price, description, image, availability and category checks; provider-neutral product payloads for six channel families.
- `shopify_catalog.py`: authenticated Admin GraphQL cursor pagination for active products and every variant; exact gross margin uses `price` and `InventoryItem.unitCost`, and only in-stock variants with known cost and at least 20% gross margin qualify. It is read-only and does not yet supply customer-intent events or update Meta catalog/product sets.
- `creative_factory.py`: OpenAI Responses structured output, image edits from supplied product photography, official-logo compositing, visual review, history-informed quality score. The score is a quality review, not a sales forecast.
- `gmc_diagnostics.py`: OAuth service-account token refresh and bounded, read-only Merchant API account/product issue diagnostics.
- `micro_budget.py`: fail-closed one-campaign/€5-lifetime, seven-day readiness gate that requires verified Purchase tracking and a matching eligible product-intent rank.
- `media_buyer.py`: official Meta Ad Library client, read-only account/Page/Pixel readiness check, and constrained `MetaPublisher`, normalized metrics, conservative ROAS/CPA/CTR recommendations, cross-channel transfer proposals, 12–24-hour loop, SQLite audit log and guarded execution engine.
- `main_pilot.py`: authenticated API for feed checks, feed preparation, creative candidates, optimization plans, dry-run execution, competitor examples and audit history.

## Run locally

```sh
cd homestro-marketing-pilot
python -m venv .venv
. .venv/bin/activate
pip install -r adtech_pilot/requirements.txt
export PILOT_ADMIN_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(40))')"
uvicorn adtech_pilot.main_pilot:app --host 127.0.0.1 --port 8080
```

Provide `X-Pilot-Admin-Key` for all routes except `/healthz`. Feed validation accepts a JSON body or Google Merchant XML; `/feed/prepare/{channel}` supports `meta`, `google`, `tiktok`, `pinterest`, `microsoft`, `sklik` and returns a plan only.

## Deployment architecture

The repository-root `Dockerfile.adtech-pilot` builds a minimal non-root Python image, leaving the existing Node API `Dockerfile` untouched. `docker-compose.yml` runs the authenticated API with `restart: always`, health checks, bounded container logs and persistent `/data`. Spend protection is fixed in both Compose and application code at `DRY_RUN=True` and `MARKETING_BUDGET_LIMIT=0.0` (legacy settings are also fixed at dry-run/zero).

`.github/workflows/deploy.yml` runs the existing Node API and marketing suites, the Python tests, Ruff, mypy and a Docker build on pushes to `main`. It publishes an immutable commit-tagged image to GHCR, then deploys to a configured Docker host over SSH and verifies container health and the spend guard. The single-container Compose replacement can briefly restart the API; it is not a zero-downtime rollout. The workflow restores the prior image if the new container does not become healthy.

Before enabling deployment, configure these GitHub secrets: `PILOT_DEPLOY_HOST`, `PILOT_DEPLOY_USER`, `PILOT_DEPLOY_DIR`, `PILOT_DEPLOY_SSH_KEY`, `PILOT_DEPLOY_KNOWN_HOSTS`, and a narrowly scoped `GHCR_READ_TOKEN`. On the host, create a private `.env` with a 40+ character `PILOT_ADMIN_KEY`; the deploy job copies only Compose configuration and never replaces host secrets. A persistent Docker volume retains audit records and generated files.

This deployment starts the daemon and its available diagnostics. It does not repair/publish Merchant Center inputs, access TikTok Creative Center, or fetch paid-channel conversion metrics. The narrowly scoped Meta publisher is disabled by default and requires all account and product prerequisites plus a deliberate `DRY_RUN=false` and `ALLOW_MICRO_BUDGET=true` on the host. Creative generation and GitHub reporting require explicit secrets/configuration. The existing Node Pilot does not call this service yet.

## Validation scope and production prerequisites

The tests cover feed parsing/validation, read-only GMC diagnostics, output normalization, structured model and image API handling through mocks, Meta account preflight and one-time campaign creation against a mock Graph API, scoring and micro-budget gates, attribution requirements, budget-cap reconciliation and API authentication. Live Meta OAuth approval, billing, Pixel access, ad review and real campaign delivery remain account-specific prerequisites. A historical Purchase event is not required for the first cold-start campaign. Feed corrections cannot by themselves resolve Merchant Center account-policy or shipping setup issues.


## Product intent ranking

`product_intent.py` ranks the full supplied product set using fresh, verified
ViewContent, AddToCart, InitiateCheckout and Purchase aggregates. Scores are
transparent prioritization points, not predicted ROAS or purchase probability.
Views alone cannot qualify a product: candidates need a checkout or at least
three cart additions, verified event ingestion, current stock and known positive
contribution margin. Missing, stale or future-dated evidence fails closed.
This is a decision module; it does not claim to collect Shopify events by itself.
The production event source and end-to-end Purchase verification remain release
gates before any paid campaign can run.
