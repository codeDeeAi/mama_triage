# mama-triage — production image.
#
# Targets any platform that builds a Dockerfile and runs the result: Cloud Run (what
# Chapter 3 specifies), Coolify, Railway, Render, plain Docker.
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
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tailwind.config.js ./
COPY src ./src
COPY views ./views
COPY public ./public
# Builds the CSS as well as the TypeScript: Tailwind output is generated at image build
# time and served from the same origin, not fetched from a CDN at runtime.
RUN npm run build

# ---- knowledge index --------------------------------------------------------
# Needs a Voyage API key at build time. Two ways to supply it:
#
#   BuildKit secret (preferred — never enters an image layer):
#     docker build --secret id=voyage_key,env=VOYAGE_API_KEY .
#
#   Build argument (for platforms whose UI has no secret support, Coolify included):
#     set VOYAGE_API_KEY as a *build* variable
#
# The build argument is the weaker option: build args are recorded in image history, so
# anyone who can pull the image can read the key. Acceptable for a private image and a
# scoped key that you can rotate; not something to do with a shared credential.
FROM node:20-slim AS index
WORKDIR /app
ARG VOYAGE_API_KEY=""
# Escape hatch for a deliberate build with no index — CI smoke tests, or a deployment
# that only exercises the safety paths. Must be set explicitly.
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
      echo "ALLOW_NO_INDEX=true if you genuinely intend to deploy without assessment." >&2; \
      exit 1; \
    fi

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=index /app/knowledge/index ./knowledge/index
COPY views ./views
COPY prompts ./prompts
COPY migrations ./migrations
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Never run as root.
USER node

# Liveness for the deploying platform. /healthz deliberately does not touch the database,
# so this answers "is the process up", not "is everything working" — a database blip
# should not make the platform kill and restart a healthy container. Readiness, which does
# check the database, is at /readyz.
#
# Uses node rather than curl because the slim image has no curl, and adding one to run a
# health check is a package worth of attack surface for a request node can make itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
