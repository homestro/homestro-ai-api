# Homestro AdTech Pilot (Python service)

This is a separate FastAPI service alongside the existing Node/Shopify Pilot. It prepares and validates ad inputs, generates reviewed creative candidates, analyzes aggregated campaign metrics, and records recommendations. It does not copy Tanganica's private implementation.

## Current safety state

- `PILOT_AD_DRY_RUN=true` and `PILOT_AD_MAX_BUDGET_EUR=0` are the defaults.
- No Meta/Google/TikTok/Pinterest/Microsoft/Sklik mutation adapters are wired in this first implementation. `/feed/prepare/*` creates normalized payloads only; it never uploads them.
- The execution engine refuses all writes in dry-run, verifies the reconciled portfolio total before checking the cap, and fails closed if a platform adapter is missing. Cross-platform transfers remain recommendations because two ad networks cannot provide one atomic budget transaction.
- Autopilot scheduling is disabled unless a trusted metrics loader is injected and `PILOT_AUTOPILOT_ENABLED=true` is set. Attribution and contribution margin must be verified before scaling or moving budgets.
- Creative generation is disabled unless `PILOT_CREATIVE_ENABLED=true`; text and image API requests can incur provider charges. Generated candidates are never published automatically.
- The Meta competitor connector uses only Meta's public Ad Library API. Access is account/app-dependent. Its data shows ad examples and structure, not competitor ROAS, conversions or profit. There is no scraping fallback.

## Modules

- `feed_manager.py`: bounded JSON/XML parsing, GTIN/EAN check digit, canonical product URL, price, description, image, availability and category checks; provider-neutral product payloads for six channel families.
- `creative_factory.py`: OpenAI Responses structured output, image edits from supplied product photography, official-logo compositing, visual review, history-informed quality score. The score is a quality review, not a sales forecast.
- `media_buyer.py`: official Meta Ad Library client, normalized metrics, conservative ROAS/CPA/CTR recommendations, cross-channel transfer proposals, 12–24-hour loop, SQLite audit log and one guarded execution gate.
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

This deployment starts the API service, not a completed 24/7 marketing state machine. Product feed fetching, Google Merchant Center repair/publishing, TikTok Creative Center integration, creative generation scheduling, live analytics loaders and campaign mutation adapters are not connected. Autopilot and creative generation therefore default off; no worker reports or hourly PR comments are emitted. The existing Node Pilot does not call this service yet.

## Validation scope and production prerequisites

The tests cover feed parsing/validation, output normalization, structured model and image API handling through mocks, competitor API token handling, scoring gates, attribution requirements, budget-cap reconciliation and API authentication. Live channel OAuth, API approval, conversion tracking, campaign CRUD and actual publishing adapters are not included yet. Homestro's latest Merchant Center audit also reports item disapprovals; feed validation cannot itself restore account approval.
