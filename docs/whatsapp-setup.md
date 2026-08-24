# WhatsApp Cloud API — getting a working number from Nigeria

Nigeria is **not** blocked from the WhatsApp Business Platform. Nigerian businesses run on
Cloud API routinely. If signup refused you, it was one of four specific things, none of
them a country ban — see [Why it refused](#why-it-refused) below.

Two facts that change the plan:

1. **You do not need Meta Business Verification to run this project.** Verification lifts
   *ceilings*; it does not unlock capability. Unverified you get 2 phone numbers, and
   business-initiated templates to 250 unique recipients per rolling 24 hours.
2. **Replies to people who messaged you first do not count against that 250.** This system
   is inbound-driven — a mother writes in, the orchestrator answers inside the 24-hour
   service window. That traffic is uncapped, and the first 1,000 service conversations per
   month are free.

So the unverified developer tier is not a crippled trial. For a dissertation pilot it is
the whole system. The only thing that touches the 250 cap is
[`src/scheduler/followUpRunner.ts`](../src/scheduler/followUpRunner.ts), which sends
business-initiated templates — and 250/day is far beyond a pilot cohort.

Do not start with business verification. Start with a test number, prove the webhook, and
only then decide whether you need a real one.

---

## Part 1 — Test number (free, ~20 minutes, no verification, no card)

This gets you a live WhatsApp number that talks to your handler. It sends to a maximum of
**5 recipient numbers you nominate**, which is exactly what a supervisor demo needs.

### 1 · Meta developer account

Go to [developers.facebook.com](https://developers.facebook.com) → **Get Started**. Use a
personal Facebook account that is **more than a few weeks old and has 2FA enabled**. A
brand-new account created for this purpose is the single most common trigger for a silent
block.

### 2 · Create the app

**My Apps → Create App**. When asked what you're building, pick the **Business** /
**Other** use case, then add the **WhatsApp** product.

Meta will create a Meta Business Account for you during this flow if you don't have one.
You do not need a CAC certificate, a website, or a Facebook page at this stage.

### 3 · Take the test number

**WhatsApp → API Setup** in the left menu. You'll see:

| Field | What it is |
|---|---|
| **Test number** | Meta's, free, already provisioned. This is your sender. |
| **Phone number ID** | → `WHATSAPP_PHONE_NUMBER_ID` in `.env` |
| **WhatsApp Business Account ID** | Keep it; template submission needs it |
| **Temporary access token** | 24-hour token → `WHATSAPP_TOKEN` for now |

Under **Send and receive messages**, open the **To** field → **Manage phone number list**
→ add your own Nigerian number. It gets a confirmation code over WhatsApp. Add up to 5 —
your supervisor and any pilot testers.

Click **Send message**. If it lands on your phone, the hard part is done.

### 4 · App secret and verify token

- **App Settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`. This is load-bearing:
  [`src/http/middleware/verifySignature.ts`](../src/http/middleware/verifySignature.ts)
  rejects unsigned payloads, and `config.ts` refuses to start without it.
- `WHATSAPP_VERIFY_TOKEN` is **yours to invent** — a string you make up and type into both
  `.env` and Meta's webhook form. It is not issued to you. `openssl rand -hex 32`.

### 5 · Point the webhook at your machine

Meta must reach you over public HTTPS. Locally that means a tunnel:

```bash
npx localtunnel --port 8080
# or: cloudflared tunnel --url http://localhost:8080
```

Then **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| Callback URL | `https://<your-tunnel>/webhook` |
| Verify token | the string from step 4 |

Click **Verify and save**. Meta hits `GET /webhook` with a challenge; the handshake in
[`src/http/webhook.routes.ts`](../src/http/webhook.routes.ts) echoes it back. Watch your
logs for `webhook subscription verified` — if you don't see it, your server isn't running
or the tunnel URL is stale.

Then **Manage** → subscribe to the **`messages`** field. Easy to miss, and without it the
handshake passes but no message ever arrives.

### 6 · Permanent token

The 24-hour token will expire mid-demo. Replace it:

**business.facebook.com → Business Settings → Users → System Users → Add**, role Admin →
**Assign Assets** → your WhatsApp app, full control → **Generate New Token** → scopes
`whatsapp_business_messaging` and `whatsapp_business_management`. Set expiry to **Never**.

Copy it immediately — it is shown once. That's your real `WHATSAPP_TOKEN`.

### 7 · Fill `.env` and start

```bash
WHATSAPP_TOKEN=<permanent system-user token>
WHATSAPP_PHONE_NUMBER_ID=<from API Setup>
WHATSAPP_VERIFY_TOKEN=<the string you invented>
WHATSAPP_APP_SECRET=<App Settings → Basic>
```

All four or none — `config.ts` rejects a partial group deliberately.

---

## Part 2 — A real number (only when you need one)

The test number can't message beyond your 5 nominees. For a pilot with real mothers you
need your own number.

**Use a SIM that has never been on WhatsApp.** Not your personal number, not one that has
ever had WhatsApp or WhatsApp Business installed. A fresh MTN/Airtel/Glo line costs
almost nothing and removes the most common failure outright. Once a number is on Cloud
API you cannot use it in the WhatsApp app on a handset.

**WhatsApp → API Setup → Add phone number.** Verify by SMS or voice call. Nigerian
numbers verify fine; if SMS doesn't arrive, choose the voice call option.

Then submit the four templates in
[`docs/whatsapp-templates-submission.md`](./whatsapp-templates-submission.md). Approval is
usually hours, occasionally days, and it sits on the critical path — submit early.

### Billing

A payment method is needed only past the free tier (1,000 service conversations/month).
Nigerian card declines on Meta billing are common; a dollar card (Chipper, Grey, Geegpay)
or a domiciliary card is the usual workaround. **A pilot will not reach this.**

---

## Why it refused

<a name="why-it-refused"></a>

Ranked by how often each is the actual cause:

| Symptom | Cause | Fix |
|---|---|---|
| "Number already in use" / "already registered" | The number is on WhatsApp or WhatsApp Business on a handset | Use a number that has never had WhatsApp. Or delete the account in-app (Settings → Account → Delete), then wait |
| Country listed as unsupported at the *Coexistence* step | **Coexistence** — keeping one number on both the app and the API — was unavailable for Nigerian numbers, and reportedly enabled around April 2026. It is a feature restriction, not a platform ban | Don't use Coexistence. Take the **New Number** path. You want a dedicated bot number anyway |
| Verification wants CAC certificate, website, business email | You entered **Business Verification**, which you do not need | Back out. Use the test number in Part 1 |
| Signup dies silently, or the app won't create | New Facebook account, no 2FA, or a previously flagged ad account | Use an older personal account with 2FA on |

Two things this is **not**: it is not a country ban on the WhatsApp Business Platform, and
it is not something a BSP like Wati or 360dialog gets you around — they sit on the same
Meta infrastructure and hit the same checks.

---

## Meanwhile

Telegram needs none of this — a token from [@BotFather](https://t.me/BotFather), about two
minutes, no approval of any kind. Both channels implement the same `MessageTransport`
contract, so the orchestrator, the safety layer and the renderer do not know or care which
one is live.

Keep Telegram as the demo channel and the Chapter 4 screenshots. Treat WhatsApp as the
deployment story, not as a dependency your write-up waits on.
