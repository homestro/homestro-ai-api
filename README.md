# Homestro AI Control API

Node.js/Express API prepared for Railway deployment and later Shopify/OpenAI integration.

## Security

Secrets are read only from Railway environment variables. Do not commit API keys or Shopify access tokens to GitHub.

Required for protected endpoints:
- `HOMESTRO_API_KEY`

Optional integrations:
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `OPENAI_API_KEY`

## Product rules

Defaults come from `homestro-rules.js` and are shared by the API, Product Hunter,
Shopify Sidekick and product import workflow:
- Cost <= EUR 15
- Selling price >= EUR 34.90
- Price/cost ratio >= 3x
- At least 1,000 recorded sales
- Estimated net profit >= EUR 12

These can be overridden with Railway variables.

## Endpoints

- `GET /health` — public health check
- `GET /api/status` — protected configuration status (never returns secret values)
- `POST /api/products/validate` — protected product-rule validation
