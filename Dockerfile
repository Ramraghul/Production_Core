# syntax=docker/dockerfile:1
#
# Production Core - vehicle assembly MES
#
# Multi-stage so the runtime image carries no build tooling and no dev
# dependencies. The result is a single self-contained container: HTTP, the
# Node-RED flow runtime, the MQTT broker and the simulator all live in it, with
# no database, no message broker and no sidecar to provision.

# ---------------------------------------------------------------------------
# Stage 1: install dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests first so this layer is cached whenever only source changes.
COPY package.json package-lock.json* ./

# `npm ci` when a lockfile is present (reproducible), `npm install` otherwise.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# shutdown handler gets to flush a final snapshot.
RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    PORT=1880 \
    HOST=0.0.0.0 \
    PC_STORE=memory \
    PC_MQTT_PORT=1883 \
    PC_SEED_ON_BOOT=true \
    PC_SIM_ENABLED=true \
    PC_SIM_AUTOSTART=true \
    PC_NODERED_USER_DIR=/app/data/.node-red \
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY nodes ./nodes
COPY flows ./flows
COPY tools ./tools
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts

# Fail the build rather than ship an image whose committed flows have drifted
# from their source spec.
RUN node tools/build-flows.js --check

# Boot the application once at build time. This fails the build if the flows do
# not actually load, and leaves the Node-RED user directory created and
# populated before the image drops to an unprivileged user.
RUN mkdir -p /app/data && node scripts/warmup.js

# Run as the unprivileged user that the base image already provides.
RUN chown -R node:node /app
USER node

EXPOSE 1880 1883

# The readiness endpoint reports 503 until the plant model is loaded, so an
# orchestrator does not route traffic to a half-started instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/ready" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
