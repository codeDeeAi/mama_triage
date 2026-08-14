#!/bin/sh
# Runs migrations before starting, when RUN_MIGRATIONS_ON_BOOT=true.
#
# Opt-in rather than automatic: convenient on a single instance, but on many replicas a
# long migration blocks every startup at once. Safe either way — node-pg-migrate takes a
# Postgres advisory lock, so concurrent boots serialise.

set -e

if [ "$RUN_MIGRATIONS_ON_BOOT" = "true" ]; then
  if [ -z "$DATABASE_URL" ]; then
    echo "FATAL: RUN_MIGRATIONS_ON_BOOT=true but DATABASE_URL is not set." >&2
    exit 1
  fi

  echo "==> Waiting for the database to accept connections..."
  i=0
  until node -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
  " 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "FATAL: database unreachable after 60s. Check DATABASE_URL, and that the" >&2
      echo "       database exists — 'database does not exist' is not a credentials error." >&2
      exit 1
    fi
    sleep 2
  done

  echo "==> Running migrations..."
  node_modules/.bin/node-pg-migrate up -m migrations
  echo "==> Migrations complete."
fi

# Build the knowledge index here rather than during the image build.
#
# Coolify cannot put a value behind a compose-managed build arg — it passes
# `--build-arg VOYAGE_API_KEY` with nothing behind it — so the key is only ever available
# at runtime. Embedding on first boot uses the key the app already needs for query
# embedding, and keeps it out of image history entirely.
#
# The index lives on a volume, so this is once per volume, not once per deploy. It is
# rebuilt only when the corpus or the embedding model actually changes.
if [ "$BUILD_INDEX_ON_BOOT" = "true" ]; then
  INDEX_PATH="${CHROMA_PATH:-./knowledge/index}"
  case "$INDEX_PATH" in *.json) : ;; *) INDEX_PATH="$INDEX_PATH/index.json" ;; esac

  if INDEX_PATH="$INDEX_PATH" node -e "
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const p = process.env.INDEX_PATH;
    if (!fs.existsSync(p)) process.exit(1);
    const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    // A placeholder index is not a real one. It is built by the offline hash embedder to
    // exercise the pipeline and contains no clinical content.
    if (idx.embeddingModel !== (process.env.EMBEDDING_MODEL || 'voyage-3')) process.exit(1);
    const dir = process.env.CORPUS_DIR || 'knowledge/sources';
    const have = new Set((idx.sources || []).map((s) => s.sha256));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!have.has(crypto.createHash('sha256').update(raw, 'utf8').digest('hex'))) process.exit(1);
    }
    process.exit(0);
  " 2>/dev/null; then
    echo "==> Knowledge index is current."
  elif [ -n "$VOYAGE_API_KEY" ]; then
    echo "==> Building the knowledge index (corpus or model changed)..."
    node dist/rag/ingest.js
    echo "==> Knowledge index built."
  else
    echo "FATAL: BUILD_INDEX_ON_BOOT=true but VOYAGE_API_KEY is not set, and the" >&2
    echo "       existing index is missing, stale, or a placeholder." >&2
    echo "" >&2
    echo "Starting anyway would answer every mother from the red-flag paths alone," >&2
    echo "while looking healthy. Set VOYAGE_API_KEY, or set BUILD_INDEX_ON_BOOT=false" >&2
    echo "to run deliberately without assessment." >&2
    exit 1
  fi
fi

exec "$@"
