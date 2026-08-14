# mama-triage — production image.

# ---- dependencies -----------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tailwind.config.js ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN npm run build

# ---- knowledge index --------------------------------------------------------
# Built into the image so an evaluation run is pinned to an image digest rather than to
# whatever was in a vector database that afternoon.
#
# Supply the key either way:
#   docker build --secret id=voyage_key,env=VOYAGE_API_KEY .   (preferred)
#   docker build --build-arg VOYAGE_API_KEY=...                (build args are recorded
#                                                               in image history)
FROM node:20-slim AS index
WORKDIR /app
ARG VOYAGE_API_KEY=""
ARG ALLOW_NO_INDEX="false"
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY knowledge/sources ./knowledge/sources
COPY package.json ./
RUN --mount=type=secret,id=voyage_key \
    KEY="$(cat /run/secrets/voyage_key 2>/dev/null || echo "$VOYAGE_API_KEY")"; \
    if [ -n "$KEY" ]; then \
      VOYAGE_API_KEY="$KEY" \
      CORPUS_DIR=knowledge/sources \
      CHROMA_PATH=./knowledge/index \
      node dist/rag/ingest.js; \
    elif [ "$ALLOW_NO_INDEX" = "true" ]; then \
      echo "WARNING: building without a knowledge index (ALLOW_NO_INDEX=true)."; \
      echo "The service will start with assessment disabled; safety paths remain active."; \
      mkdir -p knowledge/index; \
    else \
      echo "FATAL: no Voyage API key, so there is no knowledge index to ship." >&2; \
      echo "" >&2; \
      echo "Without it the container starts but cannot assess anything — it answers" >&2; \
      echo "every mother with the red-flag paths only. That is a degraded service that" >&2; \
      echo "looks healthy, which is worse than a build that fails here." >&2; \
      echo "" >&2; \
      echo "Supply VOYAGE_API_KEY as a build secret or build argument, or set" >&2; \
      echo "ALLOW_NO_INDEX=true and build the index on first boot instead" >&2; \
      echo "(BUILD_INDEX_ON_BOOT=true) — which is what the Coolify compose file does," >&2; \
      echo "because Coolify cannot supply a value to a compose-managed build arg." >&2; \
      exit 1; \
    fi

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=index /app/knowledge/index ./knowledge/index
# Needed at runtime as well as build time: BUILD_INDEX_ON_BOOT re-embeds from these.
COPY knowledge/sources ./knowledge/sources
COPY views ./views
COPY prompts ./prompts
COPY migrations ./migrations
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# knowledge/index must be writable by `node`, and must be owned by it *before* a named
# volume is mounted there — a volume inherits the ownership of the image directory it
# shadows, so chowning after the mount is too late.
RUN mkdir -p knowledge/index && chown -R node:node /app/knowledge

USER node

# /healthz deliberately ignores the database, so a database blip does not get a healthy
# container killed and restarted. /readyz is the one that checks dependencies.
# Uses node because the slim image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
