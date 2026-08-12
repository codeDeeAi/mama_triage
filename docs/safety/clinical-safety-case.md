# Clinical safety case

**System:** WhatsApp-accessible LLM triage and symptom assessment for postpartum mothers
and newborns in underserved Nigerian communities
**Status:** Research prototype — simulated evaluation only, no real end users
**Author:** Adeola Bada (2024/C/MIT/0127) · MIVA Open University

> This document states the hazards the system could cause, the control for each, and the
> residual risk that remains. It is referenced from Chapter 3 and forms the basis of the
> limitations section in Chapter 5. If this work were ever taken beyond a prototype, this
> is the artefact a regulator would ask for first.

---

## 1. Scope and standing limits

The system operates within limits that are enforced in code, not merely stated:

| Limit | Enforcement |
|---|---|
| No diagnosis | System prompt §4; adversarial scenario set |
| No drug names or dosages | System prompt §4; adversarial scenario set |
| Never discourages care-seeking | System prompt §4; `must_not_mention` checks in scenarios |
| Postpartum mothers and infants 0–12 months only | System prompt §4.7 |
| Research prototype, not a clinical service | Consent message shown before any assessment |
| No real patient data | Evaluation uses simulated scenarios reviewed by clinicians |
| No live deployment to end users | Project scope, Chapter 1 §1.4.2 |

---

## 2. Hazard analysis

### H1 — Under-triage: a genuine emergency is classified as lower urgency

**Severity: catastrophic.** This is the hazard that could cost a life.

| Control | Where |
|---|---|
| Deterministic red-flag register runs before and independently of the model | `src/safety/redFlags.ts` |
| Register matches both the mother's words and the model-extracted clinical slots | `matchLexical`, `matchSlots` |
| Rules may raise urgency but never lower it | `src/safety/ratchet.ts`, enforced again by a database trigger |
| Independent second-pass safety check on a different model | `src/llm/safetyCheck.ts` |
| Low-confidence `self_care` automatically promoted to `facility_visit` | `src/llm/triage.ts` |
| System prompt calibrated so poor facility access argues for *more* caution | `prompts/system.triage.v1.md` §3 |
| CI fails the build if the deterministic layer misses any smoke emergency | `npm run eval:smoke` |
| Under-triage rate is the headline evaluation metric, computed by the database | `migrations/006_eval.sql` |

**Residual risk: material.** A danger sign phrased in a way no rule matches, and which the
model also misses, will be under-triaged. The register is pattern-based and cannot be
exhaustive; two real gaps of exactly this kind were found during development ("has not
fed", "I had a fit") and both were invisible until a scenario exposed them. The scenario
bank is the mitigation and its size is a direct limit on confidence.

### H2 — Over-reliance: a mother defers seeking care because the system reassured her

**Severity: high.**

| Control | Where |
|---|---|
| Every conclusion carries explicit return warnings; the schema requires them even for `self_care` | `src/llm/schema.ts` |
| Standing disclaimer on every conclusion | `src/safety/fallback.ts` |
| Consent message states plainly it is not a doctor and gives no diagnoses | `src/orchestrator/handler.ts` |
| A frightened mother is itself grounds to advise assessment | System prompt §4.5 |

**Residual risk: material and not fully mitigable by design.** A system that answers at all
will sometimes be believed more than it should be. Measuring this properly requires real
users, which is outside this study's scope — state that limitation explicitly rather than
implying the controls resolve it.

### H3 — Hallucinated or ungrounded clinical guidance

**Severity: high.**

| Control | Where |
|---|---|
| RAG grounding in WHO IMCI and FMOH BEmONC; clinical claims must cite a retrieved chunk | `src/rag/`, prompt §5 |
| Citations validated against what was actually retrieved; a fabricated `chunk_id` invalidates the response | `src/llm/triage.ts` |
| Ungrounded retrieval is reported to the model, which is instructed to become more cautious | `renderContext`, prompt §5 |
| Structured output only — no free prose reaches the mother unvalidated | `src/llm/schema.ts` |
| Chunker never splits a danger-sign list or table, so a truncated list cannot be read as complete | `src/rag/chunk.ts` |

**Residual risk: moderate.** Grounding constrains but does not eliminate fabrication, and
retrieval can return plausible but inappropriate guidance.

### H4 — Model or infrastructure unavailable

**Severity: moderate.**

| Control | Where |
|---|---|
| Static guideline-derived danger-sign checklist sent on any LLM failure | `src/safety/fallback.ts` |
| Circuit breaker so a sustained outage fails fast rather than timing out per message | `src/llm/anthropic.ts` |
| Service still starts and runs the deterministic safety scan if the knowledge index is missing | `src/index.ts` |
| Webhook idempotency prevents duplicate advice on delivery retries | `webhook_events` |
| Second-pass check fails open so a broken safety net never blocks an assessment | `src/llm/safetyCheck.ts` |

**Residual risk: low.** The system never goes silent; the failure mode is degraded advice,
not absent advice.

### H5 — Adversarial input or prompt injection

**Severity: moderate.**

| Control | Where |
|---|---|
| Deterministic scan runs on the mother's raw words before the model is called at all | `src/orchestrator/handler.ts` |
| Prompt instructs that message text is evidence, never instruction | Prompt §4.8 |
| Adversarial scenarios include injection, minimisation, and dosage requests | `eval/scenarios/adversarial/` |
| Webhook requires a valid HMAC signature | `src/http/middleware/verifySignature.ts` |

**Residual risk: low for the injection path specifically** — verified: in the committed
injection scenario the emergency is issued before the injection is ever sent to the model.

### H6 — Language misunderstanding, particularly Pidgin

**Severity: high**, because it falls hardest on the users the system exists to serve.

| Control | Where |
|---|---|
| Red-flag register carries Pidgin patterns alongside English | `src/safety/redFlags.ts` |
| Negation guard handles Pidgin constructions where the negation *is* the danger sign ("no dey chop") | `src/safety/negation.ts` |
| Retrieval embeds clinical state rather than the mother's surface words, so a Pidgin speaker is not disadvantaged by an English corpus | `src/rag/retrieve.ts` |
| Results reported per-language, never averaged | `src/eval/report.ts` |

**Residual risk: material.** The Pidgin scenario set is small. If per-language results
diverge, report that as a finding rather than a limitation to be explained away.

### H7 — Privacy breach

**Severity: moderate.**

| Control | Where |
|---|---|
| Phone numbers never persisted; `wa_id_hash` is HMAC-SHA256 with a secret pepper held outside the database | `src/privacy/hashPhone.ts` |
| Message bodies PII-redacted before storage; the repository refuses to write a body that still looks unredacted | `src/privacy/redact.ts`, `message.repo.ts` |
| Logger redaction configured centrally, not left to call sites | `src/telemetry/logger.ts` |
| Consent recorded before any assessment | `sessions.consent_at` |
| Aligns with the Nigeria Data Protection Act 2023 | Chapter 3 §3.2.3 |

**Residual risk: moderate.** Free-text de-identification cannot be complete; a mother may
write an identifying detail no pattern catches. This is why redaction sits behind consent,
access control and retention limits rather than being relied on alone.

### H8 — Unverified clinical logic reaching published results

**Severity: high** — an academic and clinical integrity hazard rather than a patient one.

| Control | Where |
|---|---|
| Every rule ships `verified: false` until clinical sign-off | `src/safety/redFlags.ts` |
| `assertRegisterVerified()` throws; the evaluation runner calls it | `src/eval/runner.ts` |
| Generated reports stamped **NOT REPORTABLE** while any rule is unverified | `src/eval/report.ts` |
| Reviewer sign-off document generated from the live register, so it cannot drift | `npm run docs:register` |
| CI fails if the reviewer document is stale relative to the register | `.github/workflows/ci.yml` |

**Residual risk: low**, provided the gate is not bypassed.

---

## 3. Residual risk summary

| Hazard | Residual risk | Fully mitigable within this study? |
|---|---|---|
| H1 Under-triage | Material | No — bounded by scenario bank size |
| H2 Over-reliance | Material | No — needs real users to measure |
| H3 Hallucination | Moderate | No — reduced, not eliminated |
| H4 Unavailability | Low | Yes |
| H5 Adversarial input | Low | Largely |
| H6 Language misunderstanding | Material | No — bounded by Pidgin scenario coverage |
| H7 Privacy | Moderate | No — free-text de-identification is imperfect |
| H8 Unverified logic | Low | Yes |

The four **material** residual risks are the honest content of Chapter 5's limitations
section. None is resolved by the controls listed; each is bounded by them.

---

## 4. Conditions on any use beyond this prototype

Deploying to real mothers would require, at minimum:

1. Full clinical sign-off of the red-flag register against current guideline editions.
2. Evaluation on real, not simulated, presentations, with clinical oversight.
3. Ethics approval and an incident-reporting route for missed emergencies.
4. Regulatory assessment — this would likely constitute a medical device in most
   jurisdictions.
5. A named clinical safety officer.
6. Durable, auditable storage of evidence and outcomes.

None of these is satisfied by this project, and none is claimed to be.
