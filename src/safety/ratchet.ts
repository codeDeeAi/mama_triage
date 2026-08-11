/**
 * Urgency ratchet — the monotonic escalation guarantee.
 *
 * Within a session, urgency may only ever increase. No component (the LLM, the
 * second-pass safety check, the orchestrator, or a later red-flag evaluation) may lower
 * an urgency tier that has already been assigned.
 *
 * This is the codified form of the "err on the side of caution" non-functional
 * requirement in Chapter 3, section 3.2.3. It is deliberately tiny, dependency-free and
 * exhaustively tested: if any single function in this codebase must be correct, it is
 * this one.
 */

import { URGENCY_RANK, type Urgency } from '../types';

/**
 * Combine a session's current urgency with a newly proposed one.
 *
 * @param current  The session high-water mark, or null if nothing assigned yet.
 * @param proposed The newly proposed urgency.
 * @returns The more urgent of the two. Never lower than `current`.
 */
export function ratchet(current: Urgency | null | undefined, proposed: Urgency): Urgency {
  if (current === null || current === undefined) return proposed;
  return URGENCY_RANK[proposed] > URGENCY_RANK[current] ? proposed : current;
}

/**
 * Reduce many proposed urgencies to the highest.
 *
 * Used where several independent components each produce an opinion in the same turn —
 * the deterministic rules layer, the LLM, and the second-pass safety check — and the
 * system must take the most cautious.
 *
 * @param current   The session high-water mark, or null.
 * @param proposals Zero or more proposed urgencies.
 */
export function ratchetAll(
  current: Urgency | null | undefined,
  proposals: readonly Urgency[],
): Urgency | null {
  let result: Urgency | null = current ?? null;
  for (const proposed of proposals) {
    result = ratchet(result, proposed);
  }
  return result;
}

/**
 * True when moving from `from` to `to` would be a de-escalation.
 *
 * Callers use this to detect and audit an attempted downgrade rather than silently
 * absorbing it — an LLM that tries to de-escalate is a signal worth logging and
 * reporting in the evaluation (plan section 13.3, "rules-vs-LLM disagreement").
 */
export function isDeEscalation(from: Urgency | null | undefined, to: Urgency): boolean {
  if (from === null || from === undefined) return false;
  return URGENCY_RANK[to] < URGENCY_RANK[from];
}

/** True when `a` is strictly more urgent than `b`. */
export function isMoreUrgent(a: Urgency, b: Urgency): boolean {
  return URGENCY_RANK[a] > URGENCY_RANK[b];
}
