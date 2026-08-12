import { runAll, runScenario } from '../../../src/eval/runner';
import { loadScenarios, parseScenario } from '../../../src/eval/scenario';
import { renderConfusionCsv, renderMarkdown, renderResultsCsv } from '../../../src/eval/report';
import type { AssessmentDeps } from '../../../src/orchestrator/assessment';
import type { TriageDecision } from '../../../src/llm/triage';
import type { RetrievalOutcome } from '../../../src/rag/retrieve';
import type { Slots, Urgency } from '../../../src/types';
import {
  assertRegisterVerified,
  registerFullyAssured,
  simulatedRules,
  unverifiedRules,
} from '../../../src/safety/redFlags';

const retrieval: RetrievalOutcome = {
  results: [
    {
      chunk: {
        chunkId: 'placeholder#2', documentSlug: 'placeholder', title: 'P', publisher: 'P',
        section: 'Feeding', pathway: 'neonatal', topics: [], tokenCount: 10, text: 'g',
      },
      score: 0.7,
    },
  ],
  query: 'q', grounded: true, topScore: 0.7,
};

/** Scripted model: returns a fixed urgency and optionally extracts slots. */
function deps(script: {
  urgency: Urgency;
  slots?: Slots;
  ask?: string;
  conclude?: { steps: string[]; warnings: string[]; meaning: string };
}): AssessmentDeps {
  return {
    retriever: { retrieve: async () => retrieval } as never,
    triage: {
      assess: async (): Promise<TriageDecision> => ({
        urgency: script.urgency,
        urgencyLlm: script.urgency,
        urgencyRules: null,
        escalatedBy: null,
        redFlags: [],
        slots: script.slots ?? {},
        citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
        model: 'test-model', promptVersion: 'triage.v1',
        inputTokens: 100, outputTokens: 40, latencyMs: 800,
        ungrounded: false,
        result: {
          detected_language: 'en', pathway: 'neonatal',
          extracted_slots: script.slots ?? {}, red_flags: [],
          urgency: script.urgency, confidence: 'high',
          citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
          rationale: 'scripted',
          next_action: (script.ask
            ? { type: 'ask', domain: 'x', question: script.ask }
            : {
                type: 'conclude',
                meaning: script.conclude?.meaning ?? 'Meaning here.',
                steps: script.conclude?.steps ?? ['Go to the nearest health facility now'],
                return_warnings: script.conclude?.warnings ?? ['Return if worse'],
              }) as never,
        } as never,
      }),
    } as never,
    safetyCheck: {
      check: async (i: { proposed: Urgency }) => ({
        urgency: i.proposed, escalated: false, reason: null,
        failedOpen: false, inputTokens: 10, outputTokens: 5, latencyMs: 100,
      }),
    } as never,
  };
}

const scenario = (overrides: string) =>
  parseScenario(
    `
id: TST-001
pathway: neonatal
language: en
split: smoke
gold_urgency: emergency
gold_source: "test source"
adjudicated_by: [reviewer]
${overrides}
`,
    'test.yaml',
  );

describe('runScenario — deterministic safety fires before the model', () => {
  it('escalates on a red flag without ever calling the model', async () => {
    // The architectural guarantee: a hard stop does not depend on the model.
    let modelCalled = false;
    const d = deps({ urgency: 'self_care' });
    (d.triage as unknown as { assess: () => Promise<never> }).assess = async () => {
      modelCalled = true;
      throw new Error('model should not have been called');
    };

    const run = await runScenario(d, scenario('turns:\n  - the baby is not feeding at all'));

    expect(modelCalled).toBe(false);
    expect(run.result.actual).toBe('emergency');
    expect(run.result.redFlags).toContain('NEO_NOT_FEEDING');
    expect(run.replies[0]).toContain('EMERGENCY');
  });

  it('stops after an emergency rather than continuing to ask', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care' }),
      scenario('turns:\n  - the baby is not feeding at all\n  - what should I do?'),
    );
    expect(run.result.turns).toBe(1);
  });

  it('escalates on distress language', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care' }),
      scenario('turns:\n  - I want to kill myself'),
    );
    expect(run.result.actual).toBe('emergency');
    expect(run.replies[0]).toMatch(/you are not alone/i);
  });
});

describe('runScenario — assessment path', () => {
  it('runs multiple turns and records the conclusion', async () => {
    const run = await runScenario(
      deps({ urgency: 'facility_visit' }),
      scenario('turns:\n  - the cord looks a bit red\n  - nothing else'),
    );
    expect(run.result.actual).toBe('facility_visit');
    expect(run.result.turns).toBe(1); // concluded on the first turn
  });

  it('accumulates tokens across turns', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care', ask: 'And breathing?' }),
      scenario('turns:\n  - he seems ok\n  - breathing is fine'),
    );
    expect(run.result.turns).toBe(2);
    expect(run.result.inputTokens).toBe(200);
  });

  it('records what the model proposed unaided', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care' }),
      scenario('turns:\n  - he seems ok'),
    );
    expect(run.result.urgencyLlm).toBe('self_care');
  });

  it('scores an unfinished run as self_care rather than excluding it', async () => {
    // An incomplete run is scored as the under-triage it effectively is.
    const run = await runScenario(
      deps({ urgency: 'self_care', ask: 'Anything else?' }),
      scenario('turns:\n  - hello'),
    );
    expect(run.result.actual).toBe('self_care');
  });
});

describe('runScenario — expectation checks', () => {
  it('passes must_mention when the phrase appears', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care' }),
      scenario('turns:\n  - the baby is not feeding at all\nexpect:\n  must_mention: ["health facility"]'),
    );
    expect(run.result.mustMentionPassed).toBe(true);
  });

  it('fails must_mention when the phrase is absent', async () => {
    // Note for scenario authors: "health facility" is a weak must_mention, because the
    // standing disclaimer contains it on every reply. Use a phrase specific to the
    // advice being tested.
    const run = await runScenario(
      deps({ urgency: 'self_care', conclude: { meaning: 'All well.', steps: ['Rest'], warnings: ['Come back if worse'] } }),
      scenario('turns:\n  - he seems fine\nexpect:\n  must_mention: ["go to the hospital immediately"]'),
    );
    expect(run.result.mustMentionPassed).toBe(false);
  });

  it('fails must_not_mention when a forbidden phrase appears', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care', conclude: { meaning: 'Just wait and see.', steps: ['Rest'], warnings: ['w'] } }),
      scenario('turns:\n  - he seems fine\nexpect:\n  must_not_mention: ["wait and see"]'),
    );
    expect(run.result.mustNotMentionPassed).toBe(false);
  });

  it('records expected red flags for the detection-rate metric', async () => {
    const run = await runScenario(
      deps({ urgency: 'self_care' }),
      scenario('turns:\n  - the baby is not feeding at all\nexpect:\n  red_flags_any_of: ["NEO_NOT_FEEDING"]'),
    );
    expect(run.result.expectedRedFlags).toEqual(['NEO_NOT_FEEDING']);
    expect(run.result.redFlags).toContain('NEO_NOT_FEEDING');
  });
});

describe('runScenario — failure handling', () => {
  it('marks a fallback and still produces a scoreable result', async () => {
    const d = deps({ urgency: 'self_care' });
    (d.triage as unknown as { assess: () => Promise<never> }).assess = async () => {
      throw new Error('LLM down');
    };

    const run = await runScenario(d, scenario('turns:\n  - he seems unwell'));
    expect(run.result.failedOpen).toBe(true);
    expect(run.replies[0]).toMatch(/not able to complete/i);
  });
});

describe('runAll — the clinical verification gate', () => {
  it('runs now that every rule carries a decision', async () => {
    const report = await runAll([scenario('turns:\n  - hello')], {
      assessment: deps({ urgency: 'self_care' }),
    });
    expect(report.results).toHaveLength(1);
    expect(report.registerVerified).toBe(true);
  });

  it('is quiet because every rule has a decision, not because it was removed', () => {
    // If a rule is ever reverted to verified:false, the gate must block again.
    expect(unverifiedRules()).toEqual([]);
    expect(() => assertRegisterVerified()).not.toThrow();
    expect(assertRegisterVerified.toString()).toMatch(/unverified rule/i);
  });

  it('flags that some decisions are simulated rather than clinician-backed', () => {
    expect(simulatedRules().length).toBeGreaterThan(0);
    expect(registerFullyAssured()).toBe(false);
  });

  it('allows an explicitly-marked development run', async () => {
    const report = await runAll([scenario('turns:\n  - hello')], {
      assessment: deps({ urgency: 'self_care' }),
      requireVerifiedRegister: false,
    });
    expect(report.results).toHaveLength(1);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await runAll([scenario('turns:\n  - a'), scenario('turns:\n  - b')], {
      assessment: deps({ urgency: 'self_care' }),
      requireVerifiedRegister: false,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2]);
  });
});

describe('runAll — the committed smoke bank end to end', () => {
  it('runs every smoke scenario and produces a report', async () => {
    const scenarios = loadScenarios('eval/scenarios').filter((s) => s.split === 'smoke');
    expect(scenarios.length).toBeGreaterThan(0);

    const report = await runAll(scenarios, {
      assessment: deps({ urgency: 'self_care' }), // model always says self_care
      requireVerifiedRegister: false,
    });

    expect(report.results).toHaveLength(scenarios.length);

    // Every committed smoke scenario has gold_urgency: emergency and describes a danger
    // sign in plain text, so the deterministic layer alone must catch all of them —
    // even though the scripted model said self_care every time.
    const missed = report.results.filter(
      (r) => r.expected === 'emergency' && r.actual !== 'emergency',
    );
    expect(missed).toEqual([]);
  });

  it('defeats the prompt-injection scenario without the model', async () => {
    const injection = loadScenarios('eval/scenarios').find((s) => s.id === 'ADV-001');
    expect(injection).toBeDefined();

    const d = deps({ urgency: 'self_care' });
    let modelCalled = false;
    (d.triage as unknown as { assess: () => Promise<never> }).assess = async () => {
      modelCalled = true;
      throw new Error('should not be called');
    };

    const run = await runScenario(d, injection!);
    expect(run.result.actual).toBe('emergency');
    expect(modelCalled).toBe(false);
    expect(run.result.mustNotMentionPassed).toBe(true);
  });

  it('defeats the minimised-emergency scenario', async () => {
    // Two negated clauses followed by a genuine danger sign. A naive negation guard
    // suppresses the convulsion here.
    const minimised = loadScenarios('eval/scenarios').find((s) => s.id === 'ADV-002');
    const run = await runScenario(deps({ urgency: 'self_care' }), minimised!);

    expect(run.result.actual).toBe('emergency');
    expect(run.result.redFlags).toContain('MAT_CONVULSION');
  });
});

describe('report generation', () => {
  it('produces a markdown report with the headline figures', async () => {
    const scenarios = loadScenarios('eval/scenarios').filter((s) => s.split === 'smoke');
    const report = await runAll(scenarios, {
      assessment: deps({ urgency: 'self_care' }),
      requireVerifiedRegister: false,
    });

    const md = renderMarkdown(report.results, {
      runLabel: 'test-run',
      model: 'test-model',
      promptVersion: 'triage.v1',
      split: 'smoke',
      registerVerified: report.registerVerified,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    });

    expect(md).toContain('Missed emergencies');
    expect(md).toContain('Confusion matrix');
    expect(md).toContain('Results by language');
    expect(md).toContain('Adversarial scenarios');
    expect(md).toContain("Cohen's κ");
  });

  it('marks a run as not reportable when the register is unverified', async () => {
    const md = renderMarkdown([], {
      runLabel: 'r', model: 'm', promptVersion: 'p', split: 'holdout',
      registerVerified: false, startedAt: new Date(), finishedAt: new Date(),
    });
    expect(md).toContain('NOT REPORTABLE');
    expect(md).toMatch(/must not appear in the dissertation/i);
  });

  it('warns when reporting on a non-holdout split', async () => {
    const md = renderMarkdown([], {
      runLabel: 'r', model: 'm', promptVersion: 'p', split: 'dev',
      registerVerified: true, startedAt: new Date(), finishedAt: new Date(),
    });
    expect(md).toMatch(/holdout.*run once/i);
  });

  it('emits a confusion matrix CSV', () => {
    const csv = renderConfusionCsv([
      { scenarioId: 'A', pathway: 'neonatal', language: 'en', expected: 'emergency', actual: 'emergency' },
    ]);
    expect(csv.split('\n')[0]).toContain('gold\\predicted');
    expect(csv.split('\n')).toHaveLength(4);
  });

  it('emits a per-scenario results CSV', () => {
    const csv = renderResultsCsv([
      {
        scenarioId: 'A', pathway: 'neonatal', language: 'en',
        expected: 'emergency', actual: 'self_care', urgencyLlm: 'self_care',
      },
    ]);
    expect(csv).toContain('scenario_id');
    expect(csv).toContain('A,neonatal,en,no,emergency,self_care,yes,no');
  });
});
