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

**2. Set the build variable.** Under *Build Variables* — not runtime environment
variables, this one is needed while the image is being built:

| Variable | Value |
|---|---|
| `VOYAGE_API_KEY` | your Voyage key |

The build **fails deliberately** without it. An image with no knowledge index starts up,
passes its health check, and answers every mother using only the red-flag rules — a
degraded service that looks healthy. A failed build is the better outcome, so it is not
silently allowed. If you genuinely want that (a smoke test, say), set `ALLOW_NO_INDEX=true`
as a build variable too.

**3. Set the runtime environment variables.**

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | for assessment | Without it the safety layer still runs; assessment is disabled |
| `VOYAGE_API_KEY` | for assessment | Needed at runtime as well as build time |
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

**4. Assign a domain** in Coolify. TLS is handled for you.

**5. Deploy.**

---

## What happens on deploy

```
==> Waiting for the database to accept connections...
==> Running migrations...
> Migrating files: 001_sessions … 010_sms_optin
==> Migrations complete.
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

**Point Telegram at the deployment.** Replace `<domain>` with your Coolify domain, and use
the `TELEGRAM_WEBHOOK_SECRET` value Coolify generated:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<domain>/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Webhook mode replaces long-polling — do not run `npm run telegram:poll` against the same
bot at the same time, or updates will be delivered to whichever asks first and each
message will be handled once, unpredictably.

**Check it is alive.**

```bash
curl https://<domain>/healthz   # process is up; does not touch the database
curl https://<domain>/readyz    # {"status":"ready","checks":{"database":"ok"}}
```

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

## Troubleshooting

| Symptom | Cause |
|---|---|
| Build fails with `FATAL: no Voyage API key` | Working as intended. Set `VOYAGE_API_KEY` as a **build** variable, not just a runtime one |
| `FATAL: database unreachable after 60s` | Check `DATABASE_URL`. Note that `database "x" does not exist` is *not* a credentials error — the database has to be created first |
| Container healthy, but replies never arrive | The Telegram webhook is not set, or is pointing at an old domain. Check `getWebhookInfo` |
| `assessment disabled` in the logs | `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` missing at **runtime**. Safety paths still work |
| Postgres will not start after a version change | PG18 expects the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data` |
| Registered mothers stop being recognised | `PHONE_HASH_PEPPER` changed. Identity is an HMAC keyed on it, so it must stay stable for the life of the deployment |
