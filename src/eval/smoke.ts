/**
 * CI safety gate.
 *
 * Runs the `smoke` scenario split against a **deliberately broken model** — a stub that
 * always answers `self_care` — and fails the build if any emergency scenario is not
 * classified as an emergency.
 *
 * The point is not to measure the model. It is to prove, on every commit, that the
 * deterministic safety layer catches every smoke emergency **on its own**, with no
 * language model involved. If a future change to the red-flag register, the negation
 * guard, or the ratchet weakens that, the build breaks.
 *
 * This is the most valuable single piece of automation in the project, and it needs no
 * API keys, so it runs on every pull request.
 *
 * Run with: npm run eval:smoke
 */

import { loadScenarios } from './scenario';
import { runAll } from './runner';
import { summarise } from './metrics';
import type { AssessmentDeps } from '../orchestrator/assessment';
import type { TriageDecision } from '../llm/triage';
import type { RetrievalOutcome } from '../rag/retrieve';

/** Retrieval double: returns one chunk so citation handling behaves normally. */
const RETRIEVAL: RetrievalOutcome = {
  results: [
    {
      chunk: {
        chunkId: 'stub#1',
        documentSlug: 'stub',
        title: 'stub',
        publisher: 'stub',
        section: 'stub',
        pathway: 'unset',
        topics: [],
        tokenCount: 1,
        text: 'stub guidance',
      },
      score: 0.5,
    },
  ],
  query: 'stub',
  grounded: true,
  topScore: 0.5,
};

/**
 * A model that always answers `self_care`, whatever it is shown.
 *
 * Anything the run still classifies correctly was classified by the deterministic layer.
 */
export function brokenModelDeps(): AssessmentDeps {
  return {
    retriever: { retrieve: async () => RETRIEVAL } as never,
    triage: {
      assess: async (): Promise<TriageDecision> => ({
        urgency: 'self_care',
        urgencyLlm: 'self_care',
        urgencyRules: null,
        escalatedBy: null,
        redFlags: [],
        slots: {},
        citations: [{ chunk_id: 'stub#1', claim: 'stub' }],
        model: 'CI-STUB-always-self-care',
        promptVersion: 'ci',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        ungrounded: false,
        result: {
          detected_language: 'en',
          pathway: 'neonatal',
          extracted_slots: {},
          red_flags: [],
          urgency: 'self_care',
          confidence: 'high',
          citations: [{ chunk_id: 'stub#1', claim: 'stub' }],
          rationale: 'CI stub',
          next_action: {
            type: 'conclude',
            meaning: 'Nothing concerning found.',
            steps: ['Continue normal care'],
            return_warnings: ['Return if anything changes'],
          } as never,
        } as never,
      }),
    } as never,
    safetyCheck: {
      // Agrees with everything: the gate must not be passed by the second-pass model.
      check: async (i: { proposed: 'self_care' | 'facility_visit' | 'emergency' }) => ({
        urgency: i.proposed,
        escalated: false,
        reason: null,
        failedOpen: false,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      }),
    } as never,
  };
}

export interface SmokeOutcome {
  passed: boolean;
  total: number;
  missedEmergencies: string[];
  forbiddenPhraseFailures: string[];
  underTriaged: string[];
}

export async function runSmokeGate(scenarioDir = 'eval/scenarios'): Promise<SmokeOutcome> {
  const scenarios = loadScenarios(scenarioDir).filter((s) => s.split === 'smoke');

  if (scenarios.length === 0) {
    throw new Error(
      `no scenarios with split: smoke found in ${scenarioDir}. The CI safety gate needs ` +
        `at least one, or it silently passes while testing nothing.`,
    );
  }

  const report = await runAll(scenarios, {
    assessment: brokenModelDeps(),
    // The gate deliberately runs against the unverified register: its job is to detect a
    // regression in the safety layer, not to produce reportable clinical results.
    requireVerifiedRegister: false,
  });

  const missedEmergencies = report.results
    .filter((r) => r.expected === 'emergency' && r.actual !== 'emergency')
    .map((r) => `${r.scenarioId} (expected emergency, got ${r.actual})`);

  const underTriaged = report.results
    .filter((r) => r.expected !== r.actual)
    .filter((r) => {
      const rank = { self_care: 0, facility_visit: 1, emergency: 2 } as const;
      return rank[r.actual] < rank[r.expected];
    })
    .map((r) => `${r.scenarioId} (${r.expected} → ${r.actual})`);

  const forbiddenPhraseFailures = report.results
    .filter((r) => r.mustNotMentionPassed === false)
    .map((r) => r.scenarioId);

  return {
    // Only emergency misses and forbidden phrases break the build. A middle-tier
    // under-triage by a stub model that always says self_care is expected, not a
    // regression — the deterministic layer is not meant to catch everything.
    passed: missedEmergencies.length === 0 && forbiddenPhraseFailures.length === 0,
    total: report.results.length,
    missedEmergencies,
    forbiddenPhraseFailures,
    underTriaged,
  };
}

/* istanbul ignore next -- CLI wiring */
async function main(): Promise<void> {
  const out = await runSmokeGate();
  const w = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  w('');
  w('CI safety gate — deterministic layer only (model stubbed to always say self_care)');
  w('─'.repeat(78));
  w(`Scenarios run:            ${out.total}`);
  w(`Missed emergencies:       ${out.missedEmergencies.length}`);
  w(`Forbidden-phrase failures:${out.forbiddenPhraseFailures.length}`);
  w(`Other under-triage:       ${out.underTriaged.length} (informational)`);
  w('');

  if (out.missedEmergencies.length > 0) {
    w('MISSED EMERGENCIES:');
    for (const m of out.missedEmergencies) w(`  ✗ ${m}`);
    w('');
  }
  if (out.forbiddenPhraseFailures.length > 0) {
    w('FORBIDDEN PHRASE PRESENT:');
    for (const m of out.forbiddenPhraseFailures) w(`  ✗ ${m}`);
    w('');
  }

  if (out.passed) {
    w('PASS — the deterministic safety layer caught every smoke emergency unaided.');
    process.exit(0);
  }

  w('FAIL — a safety regression reached the smoke set. Do not merge.');
  process.exit(1);
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`smoke gate failed to run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
