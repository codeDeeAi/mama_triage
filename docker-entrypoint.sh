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

exec "$@"
