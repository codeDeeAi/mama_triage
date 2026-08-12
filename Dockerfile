# mama-triage — production image for Cloud Run.
#
# The knowledge index is built during the image build and shipped read-only inside the
# image. That is what pins an evaluation run to an image digest: the exact knowledge base
# that produced a set of results is identified by the digest, not by whatever happened to
# be in a vector database that afternoon.

# ---- dependencies -----------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- knowledge index --------------------------------------------------------
# Requires a Voyage API key at build time, supplied as a BuildKit secret so it never
# enters an image layer:
#   docker build --secret id=voyage_key,env=VOYAGE_API_KEY .
FROM node:20-slim AS index
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY knowledge/sources ./knowledge/sources
COPY package.json ./
RUN --mount=type=secret,id=voyage_key \
    if [ -f /run/secrets/voyage_key ]; then \
      VOYAGE_API_KEY="$(cat /run/secrets/voyage_key)" \
      CORPUS_DIR=knowledge/sources \
      CHROMA_PATH=./knowledge/index \
      node dist/rag/ingest.js; \
    else \
      echo "WARNING: no voyage_key secret — building without a knowledge index."; \
      echo "The service will start with assessment disabled; safety paths remain active."; \
      mkdir -p knowledge/index; \
    fi

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=index /app/knowledge/index ./knowledge/index
COPY prompts ./prompts
COPY migrations ./migrations

# Never run as root.
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
