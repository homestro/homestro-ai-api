FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

CMD ["sh", "-c", "node ./patch-autopilot.js && node ./patch-cost-rules.js && node ./patch-shopify-auth.js && node ./patch-json-output.js && node ./server.js"]
