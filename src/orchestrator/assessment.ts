/**
 * One assessment turn.
 *
 * Sequences retrieval → triage → second-pass safety check → persistence → render, and
 * guarantees that every failure path still leaves the mother with usable advice.
 *
 * The ordering matters. The safety check runs *after* the primary decision but *before*
 * anything is sent, so an escalation it catches reaches the mother in the same turn
 * rather than the next one.
 */

import { buildFallback, type FallbackReason } from '../safety/fallback';
import { ratchet } from '../safety/ratchet';
import { LlmError } from '../llm/anthropic';
import type { SafetyCheckService } from '../llm/safetyCheck';
import type { TriageDecision, TriageService } from '../llm/triage';
import type { Retriever } from '../rag/retrieve';
import type { Language, Pathway, Slots, Urgency } from '../types';
import { nextDomain } from './pathways';
import { nextState, renderDecision } from './render';

export interface AssessmentInput {
  pathway: Pathway;
  language: Language;
  knownSlots: Slots;
  currentUrgency: Urgency | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** The mother's latest message, for retrieval when no slots are filled yet. */
  message: string;
}

export interface AssessmentOutcome {
  /** Message bodies to send, in order. */
  messages: string[];
  /** State the session should move to. */
  state: 'assessing' | 'completed' | 'escalated';
  urgency: Urgency | null;
  slots: Slots;
  /** Present when the LLM produced a usable decision; absent on the fallback path. */
  decision?: TriageDecision;
  /** Set when the second-pass check raised the urgency. */
  safetyCheckEscalated?: boolean;
  /** Set when the LLM path failed and the static fallback was sent. */
  fallbackReason?: FallbackReason;
}

export interface AssessmentDeps {
  retriever: Retriever;
  triage: TriageService;
  safetyCheck: SafetyCheckService;
  onAudit?: (event: string, detail: Record<string, unknown>) => void;
}

export async function runAssessmentTurn(
  deps: AssessmentDeps,
  input: AssessmentInput,
): Promise<AssessmentOutcome> {
  const audit = deps.onAudit ?? ((): void => undefined);

  // The state machine — not the model — decides which domain is outstanding. This is what
  // guarantees complete coverage of the assessment.
  const domain = nextDomain(input.pathway, input.knownSlots);

  let retrieval;
  try {
    retrieval = await deps.retriever.retrieve({
      pathway: input.pathway,
      slots: input.knownSlots,
      message: input.message,
      ...(domain ? { activeDomain: domain.label } : {}),
    });
  } catch (err) {
    audit('RETRIEVAL_FAILED', { error: err instanceof Error ? err.message : String(err) });
    return fallback(input, 'retrieval_failed');
  }

  let decision: TriageDecision;
  try {
    decision = await deps.triage.assess({
      pathway: input.pathway,
      knownSlots: input.knownSlots,
      currentUrgency: input.currentUrgency,
      transcript: input.transcript,
      retrieval,
    });
  } catch (err) {
    const reason: FallbackReason =
      err instanceof LlmError
        ? err.kind === 'timeout'
          ? 'llm_timeout'
          : err.kind === 'circuit_open'
            ? 'circuit_open'
            : err.kind === 'invalid_output'
              ? 'llm_invalid_output'
              : 'llm_unavailable'
        : 'llm_unavailable';

    audit('LLM_FAILOVER', {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback(input, reason);
  }

  // Second pass. Fails open, so a broken check never blocks the assessment.
  const verdict = await deps.safetyCheck.check({
    transcript: input.transcript,
    proposed: decision.urgency,
    rationale: decision.result.rationale,
  });

  const finalUrgency = ratchet(decision.urgency, verdict.urgency);
  const escalated = finalUrgency !== decision.urgency;

  // Re-render against the final urgency so the banner and the referral directive match
  // what was actually decided. Without this, an escalation by the safety check would
  // raise the recorded urgency while the mother still saw a green "care at home" banner.
  const effective: TriageDecision = escalated
    ? { ...decision, urgency: finalUrgency, escalatedBy: 'safety_check' }
    : decision;

  return {
    messages: renderDecision(effective),
    state: nextState(effective),
    urgency: finalUrgency,
    slots: effective.slots,
    decision: effective,
    safetyCheckEscalated: escalated,
  };
}

function fallback(input: AssessmentInput, reason: FallbackReason): AssessmentOutcome {
  const message = buildFallback(input.pathway, input.language, reason);
  return {
    messages: [message.body],
    // The fallback ends the session safely rather than continuing to assess.
    state: 'completed',
    urgency: input.currentUrgency,
    slots: input.knownSlots,
    fallbackReason: reason,
  };
}
