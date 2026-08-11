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

| Component | State |
|---|---|
| Repo scaffold, TypeScript, Jest | ✅ done |
| Database schema (migrations 001–006) | ✅ done — up/down round trip verified against Postgres 16.14 |
| Safety layer (red flags, negation, ratchet, distress, fallback) | ✅ done — 100% coverage, 162 tests |
| Configuration with fail-fast validation | ✅ done |
| WhatsApp webhook + session persistence | ⬜ next |
| RAG pipeline (chunk → embed → Chroma) | ⬜ |
| LLM triage with structured output | ⬜ |
| Orchestrator state machine | ⬜ |
| Evaluation harness | ⬜ |

Full build plan: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

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

---

## Layout

```
src/
  safety/         deterministic red flags, negation guard, urgency ratchet,
                  distress detection, LLM-failure fallback   ← 100% coverage required
  orchestrator/   state machine, session handling, pathway definitions
  llm/            Anthropic client, structured triage contract, second-pass safety check
  rag/            chunking, embedding, Chroma retrieval
  whatsapp/       Cloud API client, inbound parsing, signature verification
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

Every red-flag rule ships with `verified: false` and a `VERIFY:` marker on its source
field. The patterns show intended shape and coverage; **the clinical thresholds and
urgency tiers must be traced to the source guidelines (WHO IMCI, FMOH BEmONC) and signed
off by the project's clinical reviewers.** `assertRegisterVerified()` throws while any rule
is unverified, and the evaluation runner calls it — so unverified clinical logic cannot
silently produce results that reach the report.

---

## Evaluation (Objective 4)

Metrics are computed by the database from their definitions rather than by analysis code
written once and trusted. `eval_results.under_triaged` — the headline safety metric — is a
generated column, so it cannot drift from its definition.

Prompts are iterated against the `dev` scenario split and reported on `holdout`. Tuning on
the test set and reporting it is the commonest methodological error in work of this kind.
