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

  // Second pass, on concluding turns only. Fails open, so a broken check never blocks
  // the assessment.
  //
  // It exists to catch an under-triage, and an under-triage requires a triage: a turn
  // that asks another question has not decided anything yet, so there is nothing to have
  // got wrong. Running it there anyway was actively harmful — measured over 14 identical
  // runs of a mother writing "I am feeling tired", it escalated to `emergency` 8 times,
  // and not once for a danger sign she had described. Every reason given was that the
  // assessment was still incomplete, which on an early turn is not a finding, it is the
  // definition of an early turn. Because `renderDecision` turns a mid-assessment
  // emergency into a terminal referral, each of those ended the conversation with a
  // false alarm on the first thing she said.
  //
  // Mid-assessment danger signs are not left uncovered. `runSafetyScan` in the handler
  // evaluates the deterministic red-flag register against every inbound message, in
  // every state, before this code is reached — and unlike a second model, rules cannot
  // invent a reason to be frightened.
  const concluding = decision.result.next_action.type === 'conclude';
  const verdict = concluding
    ? await deps.safetyCheck.check({
        transcript: input.transcript,
        proposed: decision.urgency,
        rationale: decision.result.rationale,
      })
    : { urgency: decision.urgency, escalated: false };

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
    // The session stays open.
    //
    // This used to complete the session, which meant a transient model error sent a
    // mother back to the consent prompt to start the whole assessment again. Ending it
    // is not what makes the fallback safe — the danger-sign list is: she has, in hand,
    // the signs that mean go now, and that text is identical either way. What ending it
    // cost was every mother who had already answered three questions and was not going
    // to answer them a second time.
    //
    // Slots and the urgency high-water mark are carried through unchanged, so her next
    // message resumes the assessment where it stopped rather than restarting it. The
    // ratchet still forbids any later turn proposing something less urgent.
    state: 'assessing',
    urgency: input.currentUrgency,
    slots: input.knownSlots,
    fallbackReason: reason,
  };
}
