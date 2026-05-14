# syntax=docker/dockerfile:1.7
# Yes to Success — Dashboard backend + bundled frontend
# Built for Railway. Includes Chromium deps for Remotion.

FROM node:20-bookworm-slim AS base

# ── Chromium / headless browser dependencies ────────────────────────────────
# Remotion uses a headless Chrome to render compositions. These libs are the
# minimum needed for it to launch on Debian-slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxtst6 \
      lsb-release \
      wget \
      xdg-utils \
      tini \
   && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# ── Backend deps ────────────────────────────────────────────────────────────
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Dashboard deps + build ──────────────────────────────────────────────────
COPY dashboard/package.json dashboard/package-lock.json* ./dashboard/
RUN cd dashboard && npm ci

COPY . .

# Build the dashboard SPA so the backend can serve dist/
RUN cd dashboard && npm run build

# Pre-download Remotion's bundled browser so first render isn't slow.
# Falls back to runtime download if this fails — non-fatal.
RUN npx remotion browser ensure || echo "remotion browser ensure failed; will retry at runtime"

# Persistent dirs (Railway volume will mount over these)
RUN mkdir -p out/cards public/generated-bg public/characters config/batches

EXPOSE 8787

# Tini as PID 1 — clean child process handling for the spawned pipeline scripts
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/server.mjs"]
