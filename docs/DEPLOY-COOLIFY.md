# Deploying on Coolify

Chapter 3 specifies Google Cloud Run. Coolify runs the same image on your own server, and
the deployment is simpler — one compose file brings up the application and its database
together. Everything below has been tested against the actual image.

---

## Before you start: the database question

You have a PostgreSQL server at `62.238.33.89:5434`. **Do not point the deployment at it
as it stands.** It has `ssl = off` and the port is open to the internet, so the password
and every message a mother sends would cross the public network in plaintext. That
contradicts the privacy notice, which tells mothers their conversations are protected.

`docker-compose.coolify.yml` solves this by removing the problem instead of patching it:
Postgres runs as a service beside the application, reachable only on Coolify's internal
Docker network, publishing no host port. The traffic never leaves the machine, so there is
nothing to encrypt and no certificate to manage. This is the recommended path.

If you must use the external server instead, enable TLS on it first and append
`?sslmode=require` to the URL.

---

## Deploying

**1. New Resource → Docker Compose**, pointed at this repository, with the compose file
set to `docker-compose.coolify.yml`.

**2. Set the environment variables.** All of them are runtime variables — there is
nothing to set under *Build Variables*.

The image needs no build arguments at all, and setting any is pointless: Coolify rewrites
build args into a bare `--build-arg NAME`, which blanks whatever the compose file set.
That is why setting `ALLOW_NO_INDEX=true` in the UI changed nothing. It embeds the corpus on **first boot** instead, using the
same key the app already needs for query embedding — which also keeps the key out of
image history entirely.

The index lives on the `knowledge-index` volume, so this happens once per volume rather
than once per deploy. It is rebuilt only when the corpus files or `EMBEDDING_MODEL`
actually change, checked by comparing the SHA-256 of each source file against the index.

If the index is missing or stale and no key is set, **the container refuses to start**.
Starting would answer every mother from the red-flag paths alone while reporting healthy,
which is worse than a visible failure. To run that way deliberately, set
`BUILD_INDEX_ON_BOOT=false`.

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | for assessment | Without it the safety layer still runs; assessment is disabled |
| `VOYAGE_API_KEY` | yes | Embeds the corpus on first boot and every query thereafter |
| `DEEPSEEK_API_KEY` | optional | Standby LLM for when Anthropic is unavailable. Sends message text to a second processor — see the privacy notice |
| `EMBEDDING_MODEL` | optional | Defaults to `voyage-4-lite`, which carries a free token allowance. Changing it forces the index to rebuild |
| `TELEGRAM_BOT_TOKEN` | one channel required | |
| `TELEGRAM_BOT_USERNAME` | with Telegram | e.g. `Nne_m_BOT`, used to build the `t.me` link at registration |
| `WHATSAPP_TOKEN` … | optional | All four WhatsApp variables or none — see below |
| `KUDISMS_TOKEN`, `KUDISMS_SENDER_ID` | optional | SMS reminders |
| `STUDY_NAME` | optional | Shown at registration |
| `DEMO_ENABLED` | optional | Leave off; it is an unauthenticated chat interface onto the triage engine |

Coolify generates and stores the rest — the database password, the identity pepper, the
admin token, the Telegram webhook secret — the first time it deploys.

WhatsApp is all-or-nothing: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` must all be present or all absent.
Configuration refuses to start on a partial group, because a channel that boots and then
fails on the first real message is worse than one that never boots. `WHATSAPP_APP_SECRET`
is what authenticates the webhook; without it anyone can post to it.

**3. Assign a domain** in Coolify. TLS is handled for you.

**4. Deploy.**

---

## What happens on deploy

```
==> Waiting for the database to accept connections...
==> Running migrations...
> Migrating files: 001_sessions … 010_sms_optin
==> Migrations complete.
==> Building the knowledge index (corpus or model changed)...
==> Knowledge index built.
{"msg":"messaging channels ready","channels":["telegram"]}
{"msg":"listening","port":8080}
```

Migrations run automatically because `RUN_MIGRATIONS_ON_BOOT=true` is set in the compose
file. That removes the "deploy succeeded but the schema is stale" failure, which is the
one most likely to bite a single-instance deployment.

It is opt-in rather than automatic because it is a genuine trade-off. On one instance it
is clearly right. On many, a long migration blocks every replica's startup simultaneously,
and you would rather run them from CI. Either way it is safe to have several containers
boot at once: `node-pg-migrate` takes a Postgres advisory lock first, so one migrates and
the rest wait and then find nothing to do. Re-deploying an unchanged schema is a no-op.

If the database never becomes reachable the container exits after 60 seconds with a
message naming the likely causes, rather than restarting forever against a bad URL.

---

## After the first deploy

**Point Telegram at the deployment.** `TELEGRAM_WEBHOOK_SECRET` must be the value the
deployment is running with — Coolify generates it as `SERVICE_PASSWORD_TELEGRAMWEBHOOK`,
and the app rejects any update whose echoed secret does not match.

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
  npm run telegram:webhook -- https://<domain>
```

It checks `/healthz` before registering. Telegram accepts a webhook pointed at a URL that
is not serving, so an unchecked registration fails later as silence rather than as an
error.

**HTTPS is required, with a certificate from a real CA.** Telegram rejects self-signed
certificates. A fresh Coolify deployment serves `CN=TRAEFIK DEFAULT CERT` until the domain
is configured with an `https://` scheme, which is what triggers Let's Encrypt issuance —
set it in *Configuration → Domains*, not just as a display URL.

Webhook mode replaces long-polling — do not run `npm run telegram:poll` against the same
bot at the same time, or updates will be delivered to whichever asks first and each
message will be handled once, unpredictably.

**Check it is alive.**

```bash
curl https://<domain>/healthz   # process is up; does not touch the database
curl https://<domain>/readyz    # database and assessment status
```

`/readyz` names the assessment state, because a mother is told the same "not available
right now" whether the credentials are missing or the index failed to load:

```json
{"status":"ready","checks":{"database":"ok","assessment":"ok (215 chunks, voyage-4-lite)"}}
{"status":"ready","checks":{"database":"ok","assessment":"disabled — not configured: ANTHROPIC_API_KEY"}}
```

Assessment being down does not make the deployment unready. Consent, pathway selection
and the whole deterministic red-flag layer still work, and taking the container out of
the load balancer would remove those too.

`/healthz` is what the container health check uses, and it deliberately ignores the
database: a brief database blip should not cause the platform to kill and restart an
otherwise healthy container. `/readyz` is the one that tells you whether the database is
actually reachable.

---

## Two things that are still outstanding

Neither blocks a test deployment. Both must be done before a real participant uses this.

- **Rotate the Telegram bot token and the Postgres password.** Both were pasted into a chat
  transcript. Revoke the bot token via `@BotFather` → `/revoke`.
- **Add a contact email to the privacy notice.** `views/privacy.ejs` carries a marked TODO.
  The Nigeria Data Protection Act gives people the right to ask what you hold about them,
  and right now there is no address to ask at.

---

## Voyage rate limits

A Voyage account with no payment method on file is capped at **3 requests and 10,000
tokens per minute**, whatever plan it is on. The corpus is 215 chunks (~55k tokens), so
ingestion under that cap takes a long time and may not finish at all.

Adding a payment method lifts the cap. It does not mean paying: `voyage-4-lite`,
`voyage-4` and `voyage-4-large` include 200M free tokens, and this corpus uses a fraction
of that. `voyage-4-lite` is the default here for exactly that reason — the previous
generation (`voyage-3`) is excluded from the free allowance.

Ingestion is tuned for the constrained case regardless — 16 chunks per batch, eight
retries, and it honours the `Retry-After` header rather than its own backoff. Override
with `EMBED_BATCH_SIZE`, `EMBED_MAX_RETRIES` and `EMBED_RETRY_BASE_MS` if needed.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `FATAL: ... VOYAGE_API_KEY is not set` at boot | Set `VOYAGE_API_KEY` as a runtime environment variable. Build variables have no effect — Coolify blanks them |
| Build fails, but the error text is not in this repo's Dockerfile | Coolify prepends its own `ARG` block, so reported line numbers do not match the file. Check the deployed commit hash instead |
| Corpus re-embeds on every deploy | The `knowledge-index` volume is not persisting, or `EMBEDDING_MODEL` is changing between deploys |
| Ingestion hangs or fails with `Voyage API 429` | No payment method on the Voyage account — 3 RPM / 10k TPM. See the rate-limit section above |
| `assessment: disabled — ENOENT ... index.json` on `/readyz` | The index was never built. `npm run kb:ensure`, or check the boot logs |
| `FATAL: database unreachable after 60s` | Check `DATABASE_URL`. Note that `database "x" does not exist` is *not* a credentials error — the database has to be created first |
| Container healthy, but replies never arrive | The webhook is not set, points at an old domain, or the secret does not match the deployment. Check `getWebhookInfo` |
| `SSL certificate problem` / `CN=TRAEFIK DEFAULT CERT` | Coolify has not issued a certificate. Set the domain with an `https://` scheme so Let's Encrypt is requested |
| Bot replies "symptom assessment is not available right now" | Check `/readyz` — it names the missing variable. Usually `ANTHROPIC_API_KEY` is unset at runtime |
| Postgres will not start after a version change | PG18 expects the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data` |
| Registered mothers stop being recognised | `PHONE_HASH_PEPPER` changed. Identity is an HMAC keyed on it, so it must stay stable for the life of the deployment |
