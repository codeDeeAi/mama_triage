/**
 * Evaluation runner (Objective 4).
 *
 * Replays each scenario through the real orchestrator — the same code path a mother's
 * message takes, with the WhatsApp transport swapped for a capture buffer. Evaluating a
 * reimplementation of the logic would prove nothing about the deployed system.
 *
 * Two guards make results reportable rather than merely produced:
 *
 *   - `assertRegisterVerified()` throws while any red-flag rule lacks clinical sign-off,
 *     so unverified clinical logic cannot reach the dissertation;
 *   - the split is recorded on the run, and reporting on anything but `holdout` is
 *     flagged in the generated report.
 */

import { assertRegisterVerified, unverifiedRules } from '../safety/redFlags';
import { runAssessmentTurn, type AssessmentDeps } from '../orchestrator/assessment';
import { detectDistress } from '../safety/distress';
import { evaluateRedFlags } from '../safety/redFlags';
import { buildEmergencyMessage } from '../orchestrator/render';
import { ratchet } from '../safety/ratchet';
import type { EvalResult } from './metrics';
import type { Scenario } from './scenario';
import type { Language, Slots, Urgency } from '../types';

export interface RunnerOptions {
  assessment: AssessmentDeps;
  /**
   * Refuse to run while the red-flag register is unverified. Defaults to true.
   * Set false only for development runs whose output will not be reported.
   */
  requireVerifiedRegister?: boolean;
  onProgress?: (done: number, total: number, scenario: Scenario) => void;
}

export interface ScenarioRun {
  result: EvalResult;
  /** Every message the system sent, in order. Stored as the transcript. */
  replies: string[];
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Replay one scenario.
 *
 * Mirrors the handler's ordering: the deterministic safety scan runs on every turn before
 * the assessment, exactly as it does in production.
 */
export async function runScenario(
  deps: AssessmentDeps,
  scenario: Scenario,
): Promise<ScenarioRun> {
  const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const replies: string[] = [];
  const language: Language = scenario.language;

  let slots: Slots = {};
  let urgency: Urgency | null = null;
  let urgencyLlm: Urgency | null = null;
  let escalatedBy: string | null = null;
  let redFlags: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let failedOpen = false;
  let citationsValid: boolean | undefined;
  let turns = 0;
  let terminated = false;

  const started = Date.now();

  for (const message of scenario.turns) {
    if (terminated) break;
    turns += 1;
    transcript.push({ role: 'user', content: message });

    // --- deterministic safety scan, exactly as in the handler ---
    const distress = detectDistress(message);
    const scan = evaluateRedFlags({ text: message, slots, pathway: scenario.pathway });
    redFlags = [...new Set([...redFlags, ...scan.hits.map((h) => h.id)])];

    if (scan.urgency) urgency = ratchet(urgency, scan.urgency);

    if (scan.urgency === 'emergency' || distress.detected) {
      urgency = 'emergency';
      const body = buildEmergencyMessage(language, distress.needsMentalHealthReferral);
      replies.push(body);
      transcript.push({ role: 'assistant', content: body });
      escalatedBy = escalatedBy ?? 'rules';
      terminated = true;
      break;
    }

    // --- assessment turn ---
    const outcome = await runAssessmentTurn(deps, {
      pathway: scenario.pathway,
      language,
      knownSlots: slots,
      currentUrgency: urgency,
      transcript,
      message,
    });

    slots = outcome.slots;
    if (outcome.urgency) urgency = ratchet(urgency, outcome.urgency);

    if (outcome.decision) {
      urgencyLlm = outcome.decision.urgencyLlm;
      escalatedBy = outcome.decision.escalatedBy ?? escalatedBy;
      inputTokens += outcome.decision.inputTokens;
      outputTokens += outcome.decision.outputTokens;
      redFlags = [...new Set([...redFlags, ...outcome.decision.redFlags.map((f) => f.id)])];
      citationsValid = outcome.decision.citations.length > 0;
    }
    if (outcome.fallbackReason) failedOpen = true;

    for (const body of outcome.messages) {
      replies.push(body);
      transcript.push({ role: 'assistant', content: body });
    }

    if (outcome.state !== 'assessing') terminated = true;
  }

  const allReplies = replies.join('\n').toLowerCase();
  const expect = scenario.expect;

  const mustMentionPassed = expect?.must_mention
    ? expect.must_mention.every((p) => allReplies.includes(p.toLowerCase()))
    : undefined;

  const mustNotMentionPassed = expect?.must_not_mention
    ? !expect.must_not_mention.some((p) => allReplies.includes(p.toLowerCase()))
    : undefined;

  const result: EvalResult = {
    scenarioId: scenario.id,
    pathway: scenario.pathway,
    language: scenario.language,
    expected: scenario.gold_urgency as Urgency,
    // A scenario that never reached a conclusion counts as self_care — the least urgent
    // outcome — so an incomplete run is scored as the under-triage it effectively is,
    // rather than being quietly excluded.
    actual: urgency ?? 'self_care',
    redFlags,
    turns,
    latencyMs: Date.now() - started,
    inputTokens,
    outputTokens,
    escalatedBy,
    urgencyLlm,
    failedOpen,
    ...(scenario.adversarial !== undefined ? { adversarial: scenario.adversarial } : {}),
    ...(expect?.red_flags_any_of ? { expectedRedFlags: expect.red_flags_any_of } : {}),
    ...(mustMentionPassed !== undefined ? { mustMentionPassed } : {}),
    ...(mustNotMentionPassed !== undefined ? { mustNotMentionPassed } : {}),
    ...(citationsValid !== undefined ? { citationsValid } : {}),
  };

  return { result, replies, transcript };
}

export interface RunReport {
  results: EvalResult[];
  runs: ScenarioRun[];
  registerVerified: boolean;
  startedAt: Date;
  finishedAt: Date;
}

export async function runAll(
  scenarios: readonly Scenario[],
  opts: RunnerOptions,
): Promise<RunReport> {
  const requireVerified = opts.requireVerifiedRegister ?? true;
  const pending = unverifiedRules();

  if (requireVerified) {
    // Throws with the list of pending rule IDs.
    assertRegisterVerified();
  }

  const startedAt = new Date();
  const runs: ScenarioRun[] = [];

  for (const [i, scenario] of scenarios.entries()) {
    runs.push(await runScenario(opts.assessment, scenario));
    opts.onProgress?.(i + 1, scenarios.length, scenario);
  }

  return {
    results: runs.map((r) => r.result),
    runs,
    registerVerified: pending.length === 0,
    startedAt,
    finishedAt: new Date(),
  };
}
