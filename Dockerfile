FROM node:20-bookworm-slim

# Railway healthchecks + system Chromium for Playwright.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prevent Playwright from downloading its bundled Chromium during npm install.
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

COPY package.json ./
RUN npm install --omit=dev
COPY . .

CMD ["sh", "-c", "node ./patch-autopilot.js && node ./patch-cost-rules.js && node ./patch-shopify-auth.js && node ./patch-json-output.js && node ./server.js"]
