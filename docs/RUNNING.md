# Running and deploying

## Part 1 — Run it locally

### Prerequisites

- **Node 20** (`node -v`)
- **Docker** (for PostgreSQL)
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather) — two minutes, free

Optional: Anthropic and Voyage API keys. Without them the consent flow and the
deterministic safety layer still run; only the LLM assessment is disabled.

### First-time setup

```bash
npm install
cp .env.example .env      # then fill it in — see below
npm run db:up             # PostgreSQL 16 on localhost:5433
npm run db:migrate
npm test                  # 830 tests, no secrets or network needed
```

### Minimum `.env` to get a working bot

```bash
DATABASE_URL=postgresql://mama:mama@localhost:5433/mama_triage

TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
TELEGRAM_BOT_USERNAME=<your bot's username, without the @>

PHONE_HASH_PEPPER=<openssl rand -hex 32>
```

Generate the two secrets:

```bash
openssl rand -hex 32
```

`PHONE_HASH_PEPPER` is what makes identifiers unrecoverable. Use a real random value
before anything reaches a real person, including a reviewer — and never reuse the
development one.

### Test the bot on your phone, with no public URL

```bash
npm run telegram:poll
```

Open your bot on Telegram and send `/start`. Long polling calls Telegram from wherever
this process runs, so no tunnel, deployment or DNS is needed. It drives the same handler
the webhook does, so what you are testing is the system rather than a stand-in.

Try `my pikin no gree chop` — you should get a Pidgin emergency referral, with no LLM
credentials configured at all. That path is deterministic by design.

### Run the web server (registration, demo, webhooks)

```bash
npm start                 # or: npm run build && node dist/index.js
```

| URL | What it is |
|---|---|
| `http://localhost:8080/` | Landing page |
| `http://localhost:8080/register` | Registration — choose Telegram or WhatsApp |
| `http://localhost:8080/demo/` | Chat demo with an inspector showing *why* it answered |
| `http://localhost:8080/healthz` | Liveness |
| `http://localhost:8080/readyz` | Readiness, including the database |

`/demo` is the one to screenshot for Chapter 4: the inspector panel shows which danger
signs matched, on which words, and which guideline each traces to.

### Enable the LLM assessment

Add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
```

Then build the knowledge index once:

```bash
npm run kb:ingest
```

Restart. The log should read `assessment enabled` with a chunk count.

### Everyday commands

| Command | Purpose |
|---|---|
| `npm test` | Full suite |
| `npm run typecheck` | Types only |
| `npm run eval:smoke` | **Safety gate** — fails if the deterministic layer misses an emergency |
| `npm run telegram:poll` | Bot on your phone, no deployment |
| `npm run docs:register` | Regenerate the clinician sign-off pack |
| `npm run css` | Rebuild the stylesheet (also runs inside `npm run build`) |
| `npm run css:watch` | Rebuild CSS on change, while editing `views/` |
| `npm run db:down` | Stop PostgreSQL |

### Troubleshooting

| Symptom | Cause |
|---|---|
| `No messaging channel configured` | Set the `TELEGRAM_*` or `WHATSAPP_*` variables |
| `Telegram is partially configured` | Both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are needed |
| `database unreachable` | `npm run db:up`, then `npm run db:migrate` |
| `database "mama_triage" does not exist` | Host and credentials are fine; create it: `psql "<url>/postgres" -c 'CREATE DATABASE mama_triage;'` |
| `server does not support SSL` | The server has `ssl = off`. See the TLS note under deployment — do not carry clinical data over an unencrypted public connection |
| Postgres container will not start after a version bump | PG18 expects the volume mounted at `/var/lib/postgresql`, not `.../data`. Recreate with `docker compose down -v` |
| `assessment disabled` in the log | No LLM keys, or no index — expected until `kb:ingest` has run |
| Port 5432 already in use | Deliberate: this project uses **5433** |
| Bot does not respond to polling | A webhook is registered. `npm run telegram:poll` deletes it on start |

---

## Part 2 — Deploy it

You need three things: a container host, a managed PostgreSQL, and an HTTPS URL for the
webhook.

### Option A — Coolify (simplest; app and database in one compose file)

See **[DEPLOY-COOLIFY.md](./DEPLOY-COOLIFY.md)**. `docker-compose.coolify.yml` brings up
the application alongside its own Postgres on a private Docker network, which also removes
the unencrypted-connection problem described above — nothing crosses the public internet,
so there is no TLS to configure. Migrations run on boot.

### Using your own PostgreSQL server

If you are deploying to a VPS rather than a managed service, two things must be true
before the connection string will work:

```bash
# 1. The database has to exist. Connect to the default `postgres` database to create it.
psql "postgres://USER:PASSWORD@HOST:PORT/postgres" -c "CREATE DATABASE mama_triage;"

# 2. Then migrate.
DATABASE_URL="postgres://USER:PASSWORD@HOST:PORT/mama_triage" npm run db:migrate
```

> ⚠️ **TLS is not optional for a remote database.** If `SHOW ssl` returns `off`, the
> credentials and every message a mother sends cross the internet in plaintext. Either
> enable TLS on the server and append `?sslmode=require`, or do not expose Postgres
> publicly at all — bind it to localhost and reach it over a private network or an SSH
> tunnel. The privacy notice tells mothers their conversations are protected; an
> unencrypted public connection contradicts that.

### Option B — Google Cloud Run (what Chapter 3 specifies)

**1. Create the database**

```bash
gcloud sql instances create mama-triage-db \
  --database-version=POSTGRES_16 --tier=db-f1-micro --region=us-central1
gcloud sql databases create mama_triage --instance=mama-triage-db
gcloud sql users set-password postgres --instance=mama-triage-db --password='<strong>'
```

**2. Store secrets in Secret Manager** — never in the image or in environment files
committed to the repo:

```bash
for s in DATABASE_URL TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET \
         PHONE_HASH_PEPPER ANTHROPIC_API_KEY VOYAGE_API_KEY; do
  echo -n "<value>" | gcloud secrets create "$s" --data-file=-
done
```

**3. Build and deploy.** The knowledge index is built into the image, so an evaluation run
is pinned to an image digest:

```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/mama-triage

gcloud run deploy mama-triage \
  --image gcr.io/PROJECT_ID/mama-triage \
  --region us-central1 --allow-unauthenticated \
  --min-instances 1 \
  --add-cloudsql-instances PROJECT_ID:us-central1:mama-triage-db \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,\
TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,\
TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,\
PHONE_HASH_PEPPER=PHONE_HASH_PEPPER:latest,\
ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,\
VOYAGE_API_KEY=VOYAGE_API_KEY:latest \
  --set-env-vars=NODE_ENV=production,TELEGRAM_BOT_USERNAME=Nne_m_BOT
```

`--min-instances 1` avoids cold starts, which otherwise blow the latency target in
Chapter 3. It is not free — budget a few dollars a month, and set a billing alert on day
one.

**4. Run migrations** once, from your machine against the Cloud SQL proxy:

```bash
cloud-sql-proxy PROJECT_ID:us-central1:mama-triage-db &
DATABASE_URL='postgresql://postgres:<pw>@localhost:5432/mama_triage' npm run db:migrate
```

**5. Register the Telegram webhook** with the deployed URL:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://<your-run-url>/telegram/webhook",
       "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates":["message","callback_query"]}'
```

Verify: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — `pending_update_count`
should be 0 and `last_error_message` absent.

`npm run telegram:webhook -- https://<your-url>` does the same thing and also publishes the
command menu (`/start`, `/help`, `/commands`, `/danger`, `/restart`, `/privacy`, `/stop`),
which is what gives the bot its Menu button and slash autocomplete. The app publishes the
menu at boot as well, so this is only needed to refresh it without a redeploy.

**Publish the menu only against a deployment running this code.** The menu belongs to the
bot, not to the container: advertising a command the running version does not handle means
a mother taps `/danger` and has it answered as though she had typed a symptom.

### Option C — Railway, Render or Fly.io

Any host that runs a container and offers PostgreSQL works, and all three are
substantially less fiddly than GCP for a project this size. The steps are the same:
provision Postgres, set the environment variables, deploy the `Dockerfile`, run
migrations, register the webhook.

If deployment time is a risk to your timeline, this is where to spend it. GCP is what
Chapter 3 says, so if you switch, update Chapter 3 — the report and the deployment must
agree.

### Post-deployment checks

```bash
curl https://<your-url>/healthz      # {"status":"ok"}
curl https://<your-url>/readyz       # database: ok
```

Then open `https://<your-url>/register/`, register on Telegram, follow the deep link, and
send a message. That single walkthrough exercises registration, the deep-link binding, the
webhook, the safety layer and persistence.

### Before any real user, including a reviewer

- [ ] `PHONE_HASH_PEPPER` is a fresh random value, not the development one
- [ ] `TELEGRAM_BOT_TOKEN` regenerated if it has ever been pasted into a chat or a file
- [ ] `ADMIN_TOKEN` set — `/admin/*` returns 404 in production without one
- [ ] `DEMO_ENABLED` left unset in production: `/demo` is an unauthenticated chat
      interface onto the triage engine
- [ ] `npm run eval:smoke` passing on the deployed commit
- [ ] Billing alert configured

### What is deliberately not automated

Migrations do not run on boot. A schema change is a decision, and running one
automatically across multiple Cloud Run instances risks two of them migrating at once.
Run `npm run db:migrate` yourself, then deploy.
