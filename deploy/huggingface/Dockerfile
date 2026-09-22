# Hugging Face Spaces build.
#
# Spaces requires the app to listen on port 7860 and runs the container as a
# non-root user, both of which this image already satisfies - only the port
# differs from the default.
#
# To deploy:
#   1. Create a new Space, SDK = Docker.
#   2. Copy this file to the Space repository root as `Dockerfile`, and
#      `deploy/huggingface/README.md` to its `README.md` (the YAML front matter
#      is what configures the Space).
#   3. Copy the rest of the project alongside them, or add this repository as a
#      git remote and push.
#
# Spaces are free with no spin-down on request, though a Space with no traffic
# for 48 hours is paused until someone opens it again.

FROM node:22-alpine

RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0 \
    PC_STORE=memory \
    PC_SEED_ON_BOOT=true \
    PC_SEED_SHIFTS=3 \
    PC_SIM_ENABLED=true \
    PC_SIM_SPEED=1 \
    PC_EDITOR_READONLY=true \
    PC_MQTT_ENABLED=true \
    PC_MQTT_WS_ENABLED=true \
    PC_NODERED_USER_DIR=/app/data/.node-red \
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

COPY src ./src
COPY nodes ./nodes
COPY flows ./flows
COPY tools ./tools
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts

RUN node tools/build-flows.js --check \
 && mkdir -p /app/data \
 && node scripts/warmup.js \
 && chown -R node:node /app

USER node
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/ready" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
