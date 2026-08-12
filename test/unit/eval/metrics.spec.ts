import {
  cohensKappa,
  confusionMatrix,
  escalationMetrics,
  groupBy,
  isOverTriage,
  isUnderTriage,
  percentile,
  perTierMetrics,
  performanceMetrics,
  redFlagMetrics,
  responseChecks,
  safetyMetrics,
  summarise,
  type EvalResult,
} from '../../../src/eval/metrics';
import type { Urgency } from '../../../src/types';

function r(expected: Urgency, actual: Urgency, extra: Partial<EvalResult> = {}): EvalResult {
  return {
    scenarioId: `S${Math.random().toString(36).slice(2, 6)}`,
    pathway: 'neonatal',
    language: 'en',
    expected,
    actual,
    ...extra,
  };
}

describe('under- and over-triage', () => {
  it('identifies under-triage', () => {
    expect(isUnderTriage('emergency', 'self_care')).toBe(true);
    expect(isUnderTriage('emergency', 'facility_visit')).toBe(true);
    expect(isUnderTriage('facility_visit', 'self_care')).toBe(true);
  });

  it('does not treat a correct or raised answer as under-triage', () => {
    expect(isUnderTriage('emergency', 'emergency')).toBe(false);
    expect(isUnderTriage('self_care', 'emergency')).toBe(false);
  });

  it('identifies over-triage', () => {
    expect(isOverTriage('self_care', 'emergency')).toBe(true);
    expect(isOverTriage('facility_visit', 'emergency')).toBe(true);
    expect(isOverTriage('emergency', 'emergency')).toBe(false);
  });

  it('agrees with the database generated-column definition', () => {
    // migrations/006_eval.sql computes these in SQL; the two definitions must match or
    // the report and the database will disagree.
    const cases: Array<[Urgency, Urgency, boolean, boolean]> = [
      ['emergency', 'self_care', true, false],
      ['emergency', 'facility_visit', true, false],
      ['emergency', 'emergency', false, false],
      ['facility_visit', 'self_care', true, false],
      ['facility_visit', 'facility_visit', false, false],
      ['facility_visit', 'emergency', false, true],
      ['self_care', 'self_care', false, false],
      ['self_care', 'facility_visit', false, true],
      ['self_care', 'emergency', false, true],
    ];
    for (const [expected, actual, under, over] of cases) {
      expect(isUnderTriage(expected, actual)).toBe(under);
      expect(isOverTriage(expected, actual)).toBe(over);
    }
  });
});

describe('safetyMetrics', () => {
  it('reports a perfect run', () => {
    const m = safetyMetrics([r('emergency', 'emergency'), r('self_care', 'self_care')]);
    expect(m.underTriaged).toBe(0);
    expect(m.missedEmergencies).toBe(0);
    expect(m.emergencySensitivity).toBe(1);
  });

  it('counts missed emergencies separately from all under-triage', () => {
    const m = safetyMetrics([
      r('emergency', 'facility_visit'), // missed emergency
      r('facility_visit', 'self_care'), // under-triage, not an emergency
      r('emergency', 'emergency'),
    ]);
    expect(m.underTriaged).toBe(2);
    expect(m.missedEmergencies).toBe(1);
    expect(m.emergencyCases).toBe(2);
    expect(m.emergencySensitivity).toBeCloseTo(0.5);
  });

  it('reports over-triage without treating it as equivalent to under-triage', () => {
    const m = safetyMetrics([r('self_care', 'emergency'), r('self_care', 'emergency')]);
    expect(m.overTriaged).toBe(2);
    expect(m.overTriageRate).toBe(1);
    expect(m.underTriaged).toBe(0);
  });

  it('handles an empty result set without dividing by zero', () => {
    const m = safetyMetrics([]);
    expect(m.underTriageRate).toBe(0);
    expect(m.emergencySensitivity).toBe(0);
  });

  it('reports zero sensitivity when the bank has no emergency cases', () => {
    // A bank with no emergencies cannot support the headline metric, and the summary
    // must make that visible rather than reporting a flattering 100%.
    const m = safetyMetrics([r('self_care', 'self_care')]);
    expect(m.emergencyCases).toBe(0);
    expect(m.emergencySensitivity).toBe(0);
  });
});

describe('confusionMatrix', () => {
  it('is fully populated even for absent combinations', () => {
    const m = confusionMatrix([r('emergency', 'emergency')]);
    expect(m.emergency.emergency).toBe(1);
    expect(m.self_care.facility_visit).toBe(0);
    expect(Object.keys(m)).toHaveLength(3);
  });

  it('counts every cell', () => {
    const m = confusionMatrix([
      r('emergency', 'emergency'),
      r('emergency', 'self_care'),
      r('self_care', 'facility_visit'),
    ]);
    expect(m.emergency.emergency).toBe(1);
    expect(m.emergency.self_care).toBe(1);
    expect(m.self_care.facility_visit).toBe(1);
  });
});

describe('perTierMetrics', () => {
  it('computes precision, recall and F1 per tier', () => {
    const results = [
      r('emergency', 'emergency'),
      r('emergency', 'emergency'),
      r('emergency', 'facility_visit'),
      r('facility_visit', 'emergency'),
    ];
    const m = perTierMetrics(results);

    // emergency: tp=2, fp=1, fn=1
    expect(m.emergency.support).toBe(3);
    expect(m.emergency.precision).toBeCloseTo(2 / 3);
    expect(m.emergency.recall).toBeCloseTo(2 / 3);
    expect(m.emergency.f1).toBeCloseTo(2 / 3);
  });

  it('reports zero rather than NaN for an absent tier', () => {
    const m = perTierMetrics([r('emergency', 'emergency')]);
    expect(m.self_care.precision).toBe(0);
    expect(m.self_care.recall).toBe(0);
    expect(m.self_care.f1).toBe(0);
  });

  it('emergency recall equals emergency sensitivity', () => {
    const results = [
      r('emergency', 'emergency'),
      r('emergency', 'self_care'),
      r('self_care', 'self_care'),
    ];
    expect(perTierMetrics(results).emergency.recall).toBeCloseTo(
      safetyMetrics(results).emergencySensitivity,
    );
  });
});

describe('cohensKappa', () => {
  it('is 1 for perfect agreement across tiers', () => {
    expect(
      cohensKappa([
        r('emergency', 'emergency'),
        r('self_care', 'self_care'),
        r('facility_visit', 'facility_visit'),
      ]),
    ).toBeCloseTo(1);
  });

  it('is near 0 for chance-level agreement', () => {
    // Always guessing "emergency" on a bank that is half emergency.
    const results = [
      r('emergency', 'emergency'),
      r('self_care', 'emergency'),
      r('emergency', 'emergency'),
      r('self_care', 'emergency'),
    ];
    // Accuracy is 50% but the guess carries no information; kappa exposes that.
    expect(cohensKappa(results)).toBeCloseTo(0);
  });

  it('is negative for systematic disagreement', () => {
    expect(
      cohensKappa([r('emergency', 'self_care'), r('self_care', 'emergency')]),
    ).toBeLessThan(0);
  });

  it('handles an empty set', () => {
    expect(cohensKappa([])).toBe(0);
  });

  it('handles a single-class set without dividing by zero', () => {
    expect(cohensKappa([r('emergency', 'emergency')])).toBe(1);
    expect(cohensKappa([r('emergency', 'self_care')])).toBe(0);
  });
});

describe('percentile', () => {
  it('computes p50 and p95', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
  });

  it('handles a single value', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('handles an empty list', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('does not require sorted input', () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });
});

describe('escalationMetrics', () => {
  it('counts escalations by source', () => {
    const m = escalationMetrics([
      r('emergency', 'emergency', { escalatedBy: 'rules' }),
      r('emergency', 'emergency', { escalatedBy: 'safety_check' }),
      r('facility_visit', 'facility_visit', { escalatedBy: 'low_confidence' }),
      r('self_care', 'self_care', { escalatedBy: null }),
    ]);
    expect(m.rules).toBe(1);
    expect(m.safetyCheck).toBe(1);
    expect(m.lowConfidence).toBe(1);
    expect(m.none).toBe(1);
  });

  it('counts cases the deterministic layers rescued', () => {
    // The empirical case for the hybrid design: the model alone would have under-triaged
    // an emergency, and a safety layer corrected it.
    const m = escalationMetrics([
      r('emergency', 'emergency', { urgencyLlm: 'self_care', escalatedBy: 'rules' }),
      r('emergency', 'emergency', { urgencyLlm: 'emergency', escalatedBy: null }),
      r('emergency', 'self_care', { urgencyLlm: 'self_care', escalatedBy: null }),
    ]);
    expect(m.rescuedByLayers).toBe(1);
  });

  it('does not count a rescue that still under-triaged', () => {
    const m = escalationMetrics([
      r('emergency', 'facility_visit', { urgencyLlm: 'self_care', escalatedBy: 'rules' }),
    ]);
    expect(m.rescuedByLayers).toBe(0);
  });
});

describe('redFlagMetrics', () => {
  it('counts a detection when any expected flag fired', () => {
    const m = redFlagMetrics([
      r('emergency', 'emergency', {
        expectedRedFlags: ['NEO_NOT_FEEDING', 'NEO_LETHARGY'],
        redFlags: ['NEO_LETHARGY'],
      }),
    ]);
    expect(m.detected).toBe(1);
    expect(m.detectionRate).toBe(1);
  });

  it('counts a miss when none fired', () => {
    const m = redFlagMetrics([
      r('emergency', 'emergency', { expectedRedFlags: ['NEO_NOT_FEEDING'], redFlags: [] }),
    ]);
    expect(m.detected).toBe(0);
    expect(m.detectionRate).toBe(0);
  });

  it('ignores scenarios with no red-flag expectation', () => {
    const m = redFlagMetrics([r('self_care', 'self_care'), r('self_care', 'self_care')]);
    expect(m.expectedTotal).toBe(0);
    expect(m.detectionRate).toBe(0);
  });
});

describe('performanceMetrics', () => {
  it('computes latency percentiles and token totals', () => {
    const m = performanceMetrics([
      r('self_care', 'self_care', { latencyMs: 1000, inputTokens: 100, outputTokens: 50, turns: 3 }),
      r('self_care', 'self_care', { latencyMs: 3000, inputTokens: 200, outputTokens: 80, turns: 5 }),
    ]);
    expect(m.latencyP50).toBe(1000);
    expect(m.latencyMax).toBe(3000);
    expect(m.totalInputTokens).toBe(300);
    expect(m.totalOutputTokens).toBe(130);
    expect(m.meanTokensPerScenario).toBe(215);
    expect(m.meanTurns).toBe(4);
  });

  it('handles missing measurements', () => {
    const m = performanceMetrics([r('self_care', 'self_care')]);
    expect(m.latencyP50).toBe(0);
    expect(m.meanTurns).toBe(0);
  });
});

describe('responseChecks', () => {
  it('counts phrase checks and citation validity', () => {
    const c = responseChecks([
      r('emergency', 'emergency', {
        mustMentionPassed: true,
        mustNotMentionPassed: true,
        citationsValid: true,
      }),
      r('emergency', 'emergency', {
        mustMentionPassed: false,
        mustNotMentionPassed: true,
        citationsValid: false,
        failedOpen: true,
      }),
    ]);
    expect(c.mustMentionPassed).toBe(1);
    expect(c.mustMentionTotal).toBe(2);
    expect(c.mustNotMentionPassed).toBe(2);
    expect(c.citationsValid).toBe(1);
    expect(c.failedOpen).toBe(1);
  });

  it('ignores scenarios with no expectations set', () => {
    const c = responseChecks([r('self_care', 'self_care')]);
    expect(c.mustMentionTotal).toBe(0);
  });
});

describe('summarise', () => {
  it('produces every headline figure', () => {
    const s = summarise([
      r('emergency', 'emergency'),
      r('emergency', 'self_care'),
      r('self_care', 'self_care'),
      r('facility_visit', 'facility_visit'),
    ]);

    expect(s.n).toBe(4);
    expect(s.accuracy).toBeCloseTo(0.75);
    expect(s.safety.missedEmergencies).toBe(1);
    expect(s.perTier.emergency.support).toBe(2);
    expect(s.confusion.emergency.self_care).toBe(1);
  });

  it('handles an empty run', () => {
    const s = summarise([]);
    expect(s.n).toBe(0);
    expect(s.accuracy).toBe(0);
    expect(s.kappa).toBe(0);
  });
});

describe('groupBy', () => {
  it('reports English and Pidgin separately', () => {
    // Required, not optional: if Pidgin performs worse that is a finding to report
    // honestly, not a number to bury in an average.
    const results = [
      r('emergency', 'emergency', { language: 'en' }),
      r('emergency', 'emergency', { language: 'en' }),
      r('emergency', 'self_care', { language: 'pcm' }),
      r('emergency', 'emergency', { language: 'pcm' }),
    ];
    const byLang = groupBy(results, (x) => x.language);

    expect(byLang.en?.accuracy).toBe(1);
    expect(byLang.pcm?.accuracy).toBeCloseTo(0.5);
    expect(byLang.pcm?.safety.missedEmergencies).toBe(1);
  });

  it('groups by pathway', () => {
    const byPathway = groupBy(
      [
        r('emergency', 'emergency', { pathway: 'neonatal' }),
        r('self_care', 'self_care', { pathway: 'maternal' }),
      ],
      (x) => x.pathway,
    );
    expect(byPathway.neonatal?.n).toBe(1);
    expect(byPathway.maternal?.n).toBe(1);
  });

  it('returns an empty object for no results', () => {
    expect(groupBy([], (x) => x.language)).toEqual({});
  });
});
