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
# Embeds the corpus into the image when a key is available, which pins an evaluation run
# to an image digest rather than to whatever was in a vector database that afternoon:
#
#   docker build --secret id=voyage_key,env=VOYAGE_API_KEY .
#
# Without a key it ships an empty index and the entrypoint embeds on first boot instead.
# This stage never fails the build. It used to, to stop a keyless image reaching
# production, but that guarantee now lives in the entrypoint, which refuses to start on a
# missing or stale index — a better place for it, because it is checked on every boot
# rather than once at build time.
#
# It also has to live there. Build arguments are not reliably settable on platforms that
# generate the build command themselves: Coolify passes a bare `--build-arg NAME`, which
# overrides whatever the compose file set with an empty value. A safety gate that a
# platform can silently blank is not a safety gate.
FROM node:20-slim AS index
WORKDIR /app
ARG VOYAGE_API_KEY=""
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY knowledge/sources ./knowledge/sources
COPY package.json ./
RUN --mount=type=secret,id=voyage_key \
    KEY="$(cat /run/secrets/voyage_key 2>/dev/null || echo "$VOYAGE_API_KEY")"; \
    mkdir -p knowledge/index; \
    if [ -n "$KEY" ]; then \
      VOYAGE_API_KEY="$KEY" \
      CORPUS_DIR=knowledge/sources \
      CHROMA_PATH=./knowledge/index \
      node dist/rag/ingest.js; \
    else \
      echo "No Voyage key at build time — the entrypoint will embed on first boot."; \
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
