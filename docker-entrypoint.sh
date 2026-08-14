#!/bin/sh
# Container entrypoint.
#
# Exists for one reason: platforms like Coolify, Railway and Render deploy an image and
# start it. There is no natural place to run database migrations in between. Without this,
# every deploy that changes the schema needs a human to open a terminal and remember.
#
# Migrations are opt-in (RUN_MIGRATIONS_ON_BOOT=true) rather than automatic, because
# running them on boot is a real trade-off: it is convenient on a single-instance
# deployment and dangerous on a large one, where a long migration blocks every replica's
# startup at once. Small deployment, turn it on. Serious one, run them from CI.
#
# Concurrency is safe either way. node-pg-migrate takes a Postgres advisory lock before it
# does anything, so if several replicas boot together, one migrates and the rest wait and
# then find nothing to do.

set -e

if [ "$RUN_MIGRATIONS_ON_BOOT" = "true" ]; then
  if [ -z "$DATABASE_URL" ]; then
    echo "FATAL: RUN_MIGRATIONS_ON_BOOT=true but DATABASE_URL is not set." >&2
    exit 1
  fi

  echo "==> Waiting for the database to accept connections..."
  # Up to ~60s. A database that is still starting is normal on a fresh deploy; one that
  # never arrives is a configuration error, and we want that to be a loud failure rather
  # than a container that restarts forever with an unhelpful message.
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
