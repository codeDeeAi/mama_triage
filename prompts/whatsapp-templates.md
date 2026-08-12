# WhatsApp message templates (version templates.v1)

> Versioned like the system prompts and never edited in place — this is user-facing
> safety copy. Bump the version and re-submit to Meta rather than editing an approved
> template's meaning.

Templates are **business-initiated** messages. Everything after the mother replies is a
free-text session message and needs no template. So these exist for exactly two moments:

1. **Onboarding** — she registered somewhere else and has not yet written to us.
2. **Clinical follow-up** — the 24-hour session window has closed and a guideline says we
   should check back.

---

## Why the obvious draft is wrong

A natural first draft reads:

> "Hi {{1}}, thank you for joining {{2}}! You can now chat freely with our health bot —
> just ask any health-related question anytime and I'll do my best to help."

Three problems, in order of seriousness:

**1. It promises a scope the system does not have.** This system covers postpartum mothers
and infants **0–12 months only** (Chapter 1 §1.4.2). "Any health-related question" invites
exactly the requests the system is built to refuse — an adult relative's chest pain, an
older child, a drug dosage. Scenarios `ADV-013`, `ADV-014` and `ADV-015` test those
refusals. A mother who was told she could ask anything and is then declined has been
misled at the moment she needed help.

**2. It does not say what the system is.** The first message a mother reads is where
"research prototype, not a doctor, no diagnoses" belongs. Deferring it to the consent
message means she has already formed an expectation.

**3. "Your health, our priority" reads as marketing.** For a research prototype that is
both untrue in the ordinary sense and likely to push the template into Meta's Marketing
category, which has stricter delivery rules than Utility.

---

## Template 1 — Onboarding (English)

**Name:** `mama_triage_welcome_en`
**Category:** Utility — a service confirmation for something the user signed up for
**Language:** English

**Body**

```
Hi {{1}}, you are now registered with {{2}}.

I help mothers check danger signs for themselves and for their baby during the first year after birth. I am a research prototype, not a doctor, and I do not give diagnoses.

If something is worrying you now, tap Start below and I will ask you a few short questions.

If you think this is an emergency, do not wait for me — go to your nearest health facility straight away.
```

**Footer**

```
Research prototype. Not a medical service.
```

**Button:** Quick reply — `Start`

| Variable | Example |
|---|---|
| `{{1}}` | Amina |
| `{{2}}` | the MIVA maternal health study |

---

## Template 2 — Onboarding (Nigerian Pidgin)

**Name:** `mama_triage_welcome_pcm`
**Category:** Utility
**Language:** English (Nigeria) — Meta has no Pidgin locale; register it under `en_NG`
and note the choice in Chapter 4.

**Body**

```
Hi {{1}}, you don register with {{2}}.

I dey help mama check danger signs for herself and for her pikin for di first year after birth. Na research prototype I be, I no be doctor, and I no dey give diagnosis.

If anything dey worry you now, tap Start make I ask you small questions.

If you think say na emergency, no wait for me — go health centre wey dey near you now now.
```

**Footer**

```
Research prototype. E no be medical service.
```

**Button:** Quick reply — `Start`

---

## Template 3 — Clinical follow-up (English)

WHO IMCI requires follow-up for several classifications — jaundice at 1 day, local
bacterial infection and feeding problems at 2 days. If the 24-hour session window has
closed, a template is the only way to honour that.

**Name:** `mama_triage_followup_en`
**Category:** Utility
**Language:** English

**Body**

```
Hi {{1}}, we spoke {{2}} ago about your baby and I advised you to see a health worker.

How is your baby now? Tap below to tell me, and I will ask a few short questions.

If anything has become worse, please go to your nearest health facility now.
```

**Footer**

```
Research prototype. Not a medical service.
```

**Button:** Quick reply — `Tell you now`

| Variable | Example |
|---|---|
| `{{1}}` | Amina |
| `{{2}}` | 2 days |

---

## What each element is doing

| Element | Purpose |
|---|---|
| Names the scope in the first sentence | Prevents the out-of-scope disappointment the draft would create |
| "research prototype, not a doctor, no diagnoses" | The same standing limits the system prompt enforces (§4), stated before she relies on it |
| Emergency instruction **before** any invitation to chat | If her baby is in danger while she reads this, waiting for a conversation is the wrong advice. This is the same principle as the renderer putting the referral above the explanation |
| Quick-reply button | Her tap is an inbound message, which opens the 24-hour session window. Without a reply, free-text conversation is not permitted at all |
| Footer restating prototype status | Survives forwarding and screenshots |
| Separate Pidgin template | Meta registers one template per language; the system's Pidgin support is worthless if the first contact is English-only |

---

## How this fits the conversation flow

The system today expects the **mother to initiate**. A template does not change that — it
produces the first inbound message:

```
template sent  →  she taps "Start"  →  inbound arrives at the webhook
               →  handler sees state 'new'  →  consent prompt
               →  she accepts  →  pathway choice  →  assessment
```

The template is the invitation; the consent message is the formal opt-in and stays
separate. Do not try to collapse consent into the template: a template is business-
initiated and a tap on it is not informed consent to store a transcript.

**The deterministic safety scan still runs on that first inbound message**, so a mother
who replies "my baby is not breathing" instead of tapping Start gets an emergency referral
rather than a consent form.

---

## Submission notes

- Meta validates length and variable placement on submission. Keep the body well under
  1,024 characters, the footer under 60, and button text under 25 — all three templates
  above are comfortably inside those.
- A variable may not open or close the body. `Hi {{1}},` is fine because `Hi ` precedes it.
- Category matters: request **Utility**. Marketing categorisation carries stricter
  delivery limits and would be the wrong description of a health service confirmation.
- Approval is not instant. Submit early — it is on the same critical path as the phone
  number itself.
- `{{2}}` in the welcome template should name the study, not a product. "the MIVA maternal
  health study" is accurate; "MamaTriage Premium" would not be.

## Not yet implemented

The system has no template-sending code, because nothing in the prototype initiates
contact — every conversation so far starts with the mother. Adding it needs:

- a registration surface that captures her number and consent to be contacted;
- `sendTemplate(to, templateName, params)` on `MessageTransport`;
- a scheduler for follow-ups at the IMCI intervals.

None of that is required for the evaluation, which is why it has not been built. It is
required for a live pilot.
