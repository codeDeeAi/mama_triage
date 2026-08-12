# mama-triage

An LLM-based triage and symptom assessment system for maternal and neonatal health in
underserved Nigerian communities — a WhatsApp-accessible, context-aware clinical decision
support tool for postpartum mothers and newborns.

MSc Information Technology project · MIVA Open University, Abuja
Adeola Bada (2024/C/MIT/0127) · Supervisor: Prof. Emmanuel Mkpojiogu

> **Research prototype.** This system does not provide medical diagnoses and is not
> deployed to real end users. Evaluation is conducted against simulated clinical scenarios
> with clinical reviewers only, per the scope defined in Chapter 1 §1.4.2.

---

## Status

**725 tests.** Typecheck, build and Docker image all clean.

| Component | State |
|---|---|
| Repo scaffold, TypeScript, Jest | ✅ |
| Database schema (migrations 001–006) | ✅ up/down round trip verified against Postgres 16.14 |
| Safety layer (red flags, negation, ratchet, distress, fallback) | ✅ **100% coverage** |
| Configuration with fail-fast validation | ✅ |
| WhatsApp webhook, privacy, consent flow | ✅ signature verification, ACK-first, idempotent |
| RAG pipeline (chunk → embed → retrieve) | ✅ indexes WHO IMCI 2014 + FMOH PPH 2025 |
| LLM triage with structured output + second-pass check | ✅ |
| Assessment state machine + renderer | ✅ full conversation end to end |
| Evaluation harness (Objective 4) | ✅ metrics, runner, report generator |
| Deployment (Dockerfile, CI, `/admin/simulate`) | ✅ image builds and runs |
| Web demonstration interface (`/demo`) | ✅ drives the real handler; shows the reasoning |

### Blocked on inputs, not code

| Blocker | Effect |
|---|---|
| **Clinical reviewer sign-off** | 12 of 20 rules are traced to published guidelines; **8 maternal rules carry a SIMULATED review** — the author standing in for a clinician. Every generated report names them and marks derived figures provisional. See [`docs/requirements/red-flag-register.md`](docs/requirements/red-flag-register.md) — the sign-off pack. |
| **FMOH BEmONC / newborn-care guidelines** | Not publicly available; the PPH guideline is in, the rest of the maternal rules have no source document. See [`knowledge/SOURCES.md`](knowledge/SOURCES.md). |
| **Scenario bank adjudication** | 65 scenarios committed. Neonatal golds are WHO-traced; the 29 maternal golds are marked `PENDING CLINICAL ADJUDICATION`. |
| **A WhatsApp provider with two-way messaging** | KudiSMS cannot host this: its API has no inbound WhatsApp webhook and sends pre-approved templates only, never free text. Meta's Cloud API test number (free, 5 recipients) is the working path. The `/demo` interface keeps everything else unblocked meanwhile. |

Full build plan: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).
Hazards and residual risk: [`docs/safety/clinical-safety-case.md`](docs/safety/clinical-safety-case.md).

---

## Architecture in one paragraph

A deterministic conversational skeleton with LLM-powered understanding and generation. The
state machine decides which clinical domain to ask about next, guaranteeing complete
coverage of the five maternal and five neonatal assessment domains. The LLM does what
rule-based systems cannot: read a lay or Nigerian Pidgin description ("e no dey chop, body
dey hot") and map it to a clinical slot. **Every hard stop — distress language, absolute
danger signs, escalation — is deterministic code that runs before and independently of the
model.** If the Anthropic API is unavailable, wrong, or manipulated, the system still
routes an emergency correctly.

Three invariants hold throughout:

1. **The LLM is the reasoning layer, not the safety layer.**
2. **Every triage output is structured, cited, and reproducible.**
3. **Urgency only ever goes up** — enforced in application code *and* by a database
   trigger, because the guarantee must not depend on a single layer being correct.

---

## Getting started

```bash
npm install
cp .env.example .env          # fill in the secrets — see the contract in that file
npm run db:up                 # Postgres 16 on localhost:5433
npm run db:migrate
npm test
```

`npm test` and `npm run typecheck` need no secrets and no database.

### Requirements

- Node 20 LTS
- Docker (local Postgres)
- API keys: Anthropic, Voyage AI, WhatsApp Business Cloud API

> Local Postgres binds host port **5433**, not 5432, since 5432 is commonly already taken
> by another local instance.

---

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Full Jest suite |
| `npm run test:coverage` | With coverage; enforces 100% on `src/safety/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm run db:up` / `db:down` | Local Postgres lifecycle |
| `npm run db:migrate` | Apply migrations |
| `npm run db:rollback` | Roll back one migration |
| `npm run kb:ingest` | Rebuild the knowledge index from `knowledge/sources/` |
| `npm run docs:register` | Regenerate the clinician sign-off pack from the live register |
| `npm run eval:smoke` | **CI safety gate** — see below |
| `npm run kb:extract -- <pdf> <md>` | Extract a guideline PDF into the corpus |

### The demonstration interface

```bash
npm run build && npm start      # then open http://localhost:8080/demo
```

A browser chat driving the **real** handler — same consent flow, safety scan, state
machine and persistence, with the WhatsApp transport swapped for a capturing one. The
inspector panel shows which danger signs matched and on what words, the guideline each
traces to, and what each layer proposed. Useful for the viva, for clinical reviewers, and
for Chapter 4 screenshots. It is **not** a substitute for the WhatsApp channel.

### The safety gate

```bash
npm run eval:smoke
```

Runs the `smoke` scenarios against a model **stubbed to always answer `self_care`**, and
fails if any emergency is missed. Anything still classified correctly was caught by the
deterministic layer alone. It needs no API keys, so it runs on every pull request — and it
is the single most valuable piece of automation here: it proves on every commit that the
safety floor holds without the model.

---

## Layout

```
src/
  safety/         deterministic red flags, negation guard, urgency ratchet,
                  distress detection, LLM-failure fallback   ← 100% coverage required
  orchestrator/   state machine, session handling, pathway definitions
  llm/            Anthropic client, structured triage contract, second-pass safety check
  rag/            PDF extraction, chunking, embedding, in-process vector store
  whatsapp/       transports (Meta Cloud API, KudiSMS), parsing, signature verification
  privacy/        phone hashing, PII redaction
  db/             pool and repositories
migrations/       001–006, node-pg-migrate
eval/             scenario bank, runner, metrics  (Objective 4)
prompts/          versioned system prompts — never edited in place
knowledge/        RAG source corpus + provenance
```

---

## Safety layer

`src/safety/` is the component that must never regress, so Jest enforces **100% statement,
branch, function and line coverage** on it. The suite covers:

- **Red-flag register** — maternal and neonatal danger signs, English and Pidgin patterns,
  matched both lexically and against LLM-extracted clinical slots.
- **Negation guard** — so "she has no fever" does not escalate, while
  `"no fever, but blood dey rush"` still fires. Negations do not carry across clause
  boundaries, and a match that carries its own negation (Pidgin `"no dey chop"` — the baby
  is not eating) is never suppressed.
- **Urgency ratchet** — exhaustively tested over the 3×3 tier space.
- **Distress detection** — self-harm, infant harm, perceived death risk, acute panic.
  Deliberately does *not* apply negation suppression: "I don't want to live" must fire.
- **Fallback** — a static, guideline-derived danger-sign checklist when the LLM fails. The
  system never goes quiet.

### Clinical verification gate

Assurance is tracked at two levels, because `verified: true` alone would let a placeholder
read as clinical validation:

- **✅ traced (12 rules)** — cited to verbatim guideline text (WHO IMCI 2014, FMOH PPH 2025).
- **🟠 SIMULATED (8 rules)** — the author standing in for a clinician who has not yet been
  engaged. All maternal, including eclampsia and sepsis.

`assertRegisterVerified()` gates the evaluation runner; `registerFullyAssured()` is the
stronger claim and is currently **false**. Every generated report opens with a banner
naming the simulated rules, and a test asserts no rule's provenance ever implies clinician
sign-off.

---

## Evaluation (Objective 4)

Metrics are computed by the database from their definitions rather than by analysis code
written once and trusted. `eval_results.under_triaged` — the headline safety metric — is a
generated column, so it cannot drift from its definition.

Prompts are iterated against the `dev` scenario split and reported on `holdout`. Tuning on
the test set and reporting it is the commonest methodological error in work of this kind.
