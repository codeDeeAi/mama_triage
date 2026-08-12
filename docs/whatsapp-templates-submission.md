# WhatsApp templates — ready to submit

Copy each block into **Meta Business Suite → WhatsApp Manager → Message templates →
Create template**. Field names below match the form.

Submit all four. Approval is not instant, and it sits on the same critical path as the
phone number itself.

> Rationale for the wording is in [`prompts/whatsapp-templates.md`](../prompts/whatsapp-templates.md).
> This file is the submission copy only.

---

## 1 · Welcome (English)

| Form field | Value |
|---|---|
| **Name** | `mama_triage_welcome_en` |
| **Category** | Utility |
| **Language** | English |
| **Header** | None |
| **Footer** | `Research prototype. Not a medical service.` |
| **Buttons** | Quick reply → button text: `Start` |

**Body**

```
Hi {{1}}, you are now registered with {{2}}.

I help mothers check danger signs for themselves and for their baby during the first year after birth. I am a research prototype, not a doctor, and I do not give diagnoses.

If something is worrying you now, tap Start below and I will ask you a few short questions.

If you think this is an emergency, do not wait for me. Go to your nearest health facility straight away.
```

**Sample values** (Meta requires these for review)

| Variable | Sample |
|---|---|
| `{{1}}` | `Amina` |
| `{{2}}` | `the MIVA maternal health study` |

---

## 2 · Welcome (Nigerian Pidgin)

WhatsApp has no Pidgin locale. Register under **English (NG)** and note that choice in
Chapter 4 — it is a real limitation of the platform, not of the system.

| Form field | Value |
|---|---|
| **Name** | `mama_triage_welcome_pcm` |
| **Category** | Utility |
| **Language** | English (NG) |
| **Header** | None |
| **Footer** | `Research prototype. E no be medical service.` |
| **Buttons** | Quick reply → button text: `Start` |

**Body**

```
Hi {{1}}, you don register with {{2}}.

I dey help mama check danger signs for herself and for her pikin for di first year after birth. Na research prototype I be, I no be doctor, and I no dey give diagnosis.

If anything dey worry you now, tap Start make I ask you small questions.

If you think say na emergency, no wait for me. Go health centre wey dey near you now now.
```

**Sample values**

| Variable | Sample |
|---|---|
| `{{1}}` | `Amina` |
| `{{2}}` | `di MIVA maternal health study` |

---

## 3 · Follow-up (English)

WHO IMCI requires follow-up at fixed intervals — jaundice at 1 day, local bacterial
infection and feeding problems at 2 days. Once the 24-hour session window closes, a
template is the only way to honour that.

| Form field | Value |
|---|---|
| **Name** | `mama_triage_followup_en` |
| **Category** | Utility |
| **Language** | English |
| **Header** | None |
| **Footer** | `Research prototype. Not a medical service.` |
| **Buttons** | Quick reply → button text: `Tell you now` |

**Body**

```
Hi {{1}}, we spoke {{2}} ago about your baby, and I advised you to see a health worker.

How is your baby now? Tap below to tell me and I will ask a few short questions.

If anything has become worse, please go to your nearest health facility now.
```

**Sample values**

| Variable | Sample |
|---|---|
| `{{1}}` | `Amina` |
| `{{2}}` | `2 days` |

---

## 4 · Follow-up (Nigerian Pidgin)

| Form field | Value |
|---|---|
| **Name** | `mama_triage_followup_pcm` |
| **Category** | Utility |
| **Language** | English (NG) |
| **Header** | None |
| **Footer** | `Research prototype. E no be medical service.` |
| **Buttons** | Quick reply → button text: `Tell you now` |

**Body**

```
Hi {{1}}, we talk {{2}} ago about your pikin, and I tell you make you see health worker.

How your pikin dey now? Tap below make you tell me and I go ask small questions.

If anything don worse, abeg go health centre wey dey near you now.
```

**Sample values**

| Variable | Sample |
|---|---|
| `{{1}}` | `Amina` |
| `{{2}}` | `2 days` |

---

## Before you click submit

- **Category must be Utility.** If the form auto-selects Marketing, change it. Marketing
  carries stricter delivery limits and misdescribes a health service confirmation.
- **Fill in the sample values.** Templates are commonly rejected for missing samples
  rather than for content.
- **Do not add a header image.** It adds nothing here and gives review another surface to
  object to.
- **`{{2}}` names the study, not a product.** "the MIVA maternal health study" is
  accurate. Anything that sounds like a commercial service invites a Marketing
  re-categorisation.
- **Keep the emergency sentence.** It is the one line that must survive any edit: if her
  baby is in danger while she reads this, waiting for a conversation is the wrong advice.

## If a template is rejected

Meta rarely explains rejections in detail. In order of likelihood:

1. **Wrong category** — resubmit as Utility.
2. **Missing sample values** — add them.
3. **Read as medical advice** — the templates deliberately give none; if this is the
   stated reason, strengthen "I am a research prototype, not a doctor" rather than
   softening the emergency line.
4. **Pidgin flagged as low quality** — the `en_NG` registration is the mitigation; if it
   persists, submit the English pair first so testing is not blocked, and appeal the
   Pidgin pair separately.

## Registration status

Registered on the project WABA (Adeola Abayomi, `1049160114761094`) and recorded in
[`src/whatsapp/templates.ts`](../src/whatsapp/templates.ts):

| Template | KudiSMS `template_code` | Status |
|---|---|---|
| `mama_triage_welcome_en` | `9153948463` | ✅ registered |
| `mama_triage_welcome_pcm` | `4269075219` | ✅ registered |
| `mama_triage_followup_en` | `5929612479` | ✅ registered |
| `mama_triage_followup_pcm` | — | ⬜ **not yet registered** |

Two things to resolve:

1. **`mama_triage_followup_pcm` is missing.** Requesting it raises
   `TemplateNotRegisteredError` rather than falling back to English, because a mother who
   has been conversing in Pidgin should not receive an English follow-up.
2. **`v1_mama_triage_welcome_en` (`3014705564`) also appears on the account.** If that is
   a superseded first submission, delete it — two templates that differ only by prefix are
   an easy thing to send by mistake.

Confirm each shows **Approved**, not *Pending* or *Rejected*, before relying on it.

## What these codes do and do not unlock

Template sending is now implemented (`MessageTransport.sendTemplate`), so with these codes
the onboarding and follow-up messages **can be delivered** through KudiSMS today.

They do not enable the assessment. KudiSMS has no WhatsApp inbound webhook, so the
mother's reply never reaches the server, and no free-text endpoint, so the triage
conversation — novel text every turn — cannot be sent. `assertTransportUsable()` refuses
to start a KudiSMS transport for that reason. See `src/whatsapp/kudisms.ts`.
