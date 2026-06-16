# syntax=docker/dockerfile:1
# Playwright E2E runner — installs Chromium and runs eyegila/e2e tests.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install exact playwright version (browsers installed via --with-deps)
COPY tests/playwright/package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

# Copy e2e tests (not the full frontend — just the test files)
COPY eyegila/e2e ./e2e

CMD ["npx", "playwright", "test", "--config", "e2e/playwright.config.ts", "--reporter=list"]
