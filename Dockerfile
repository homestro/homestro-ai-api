FROM node:20-bookworm-slim

# Railway healthchecks + system Chromium for Playwright.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates chromium ffmpeg fonts-dejavu-core python3 python3-venv python3-pip \
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
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir "httpx>=0.27,<1" "pydantic>=2.9,<3" "defusedxml>=0.7.1,<1" "Pillow>=10,<13"
ENV PYTHON_EXECUTABLE=/opt/venv/bin/python

CMD ["sh", "-c", "node ./patch-autopilot.js && node ./patch-cost-rules.js && node ./patch-shopify-auth.js && node ./patch-json-output.js && node ./server.js"]
