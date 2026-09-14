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

Defaults match the Homestro product-hunter workflow:
- Cost <= $10
- Selling price >= $34.90
- Price/cost ratio >= 3x

These can be overridden with Railway variables.

## Endpoints

- `GET /health` — public health check
- `GET /api/status` — protected configuration status (never returns secret values)
- `POST /api/products/validate` — protected product-rule validation
