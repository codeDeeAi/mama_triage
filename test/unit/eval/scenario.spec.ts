import { describeBank, filterBySplit, loadScenarios, parseScenario, ScenarioError } from '../../../src/eval/scenario';

const VALID = `
id: NEO-014
pathway: neonatal
language: en
split: holdout
gold_urgency: emergency
gold_source: "WHO IMCI section 2 — young infant danger signs"
adjudicated_by:
  - reviewer_A
  - reviewer_B
turns:
  - my baby is not sucking
expect:
  red_flags_any_of:
    - NEO_NOT_FEEDING
  must_mention:
    - health facility
`;

describe('parseScenario', () => {
  it('parses a well-formed scenario', () => {
    const s = parseScenario(VALID, 'test.yaml');
    expect(s.id).toBe('NEO-014');
    expect(s.gold_urgency).toBe('emergency');
    expect(s.adjudicated_by).toHaveLength(2);
    expect(s.expect?.red_flags_any_of).toEqual(['NEO_NOT_FEEDING']);
  });

  it('rejects invalid YAML with the file name', () => {
    expect(() => parseScenario('id: [unclosed', 'broken.yaml')).toThrow(ScenarioError);
    expect(() => parseScenario('id: [unclosed', 'broken.yaml')).toThrow(/broken.yaml/);
  });

  it('requires clinician adjudication', () => {
    // An unadjudicated scenario silently skewing an accuracy figure is worse than a crash.
    const noReviewer = VALID.replace(/adjudicated_by:\n  - reviewer_A\n  - reviewer_B/, 'adjudicated_by: []');
    expect(() => parseScenario(noReviewer, 't.yaml')).toThrow(/adjudicated_by/);
  });

  it('requires a gold source so every answer is traceable', () => {
    const noSource = VALID.replace(/gold_source: .*/, 'gold_source: ""');
    expect(() => parseScenario(noSource, 't.yaml')).toThrow(/gold_source/);
  });

  it('rejects an unknown urgency tier', () => {
    expect(() => parseScenario(VALID.replace('emergency', 'very_urgent'), 't.yaml')).toThrow(
      /gold_urgency/,
    );
  });

  it('rejects an unknown split', () => {
    expect(() => parseScenario(VALID.replace('split: holdout', 'split: training'), 't.yaml')).toThrow(
      /split/,
    );
  });

  it('rejects a malformed id', () => {
    expect(() => parseScenario(VALID.replace('NEO-014', 'scenario one'), 't.yaml')).toThrow(/id/);
  });

  it('requires at least one turn', () => {
    expect(() => parseScenario(VALID.replace(/turns:\n  - my baby is not sucking/, 'turns: []'), 't.yaml')).toThrow(
      /turns/,
    );
  });

  it('rejects unknown fields, catching typos in hand-authored files', () => {
    expect(() => parseScenario(`${VALID}\ngold_urgencyy: emergency`, 't.yaml')).toThrow(
      ScenarioError,
    );
  });
});

describe('loadScenarios — the committed bank', () => {
  const scenarios = loadScenarios('eval/scenarios');

  it('loads every committed scenario', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it('validates all of them', () => {
    for (const s of scenarios) {
      expect(s.adjudicated_by.length).toBeGreaterThan(0);
      expect(s.gold_source.length).toBeGreaterThan(3);
      expect(s.turns.length).toBeGreaterThan(0);
    }
  });

  it('has unique IDs', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers both pathways and both languages', () => {
    expect(new Set(scenarios.map((s) => s.pathway))).toEqual(new Set(['neonatal', 'maternal']));
    expect(new Set(scenarios.map((s) => s.language))).toEqual(new Set(['en', 'pcm']));
  });

  it('includes adversarial scenarios', () => {
    expect(scenarios.filter((s) => s.adversarial).length).toBeGreaterThan(0);
  });

  it('still carries placeholder reviewers, pending real adjudication', () => {
    // Fails once real reviewers are recorded — which is the reminder to revisit this
    // test rather than an error.
    const placeholders = scenarios.filter((s) => s.adjudicated_by.includes('PLACEHOLDER_REVIEWER'));
    expect(placeholders.length).toBeGreaterThan(0);
  });
});

describe('filterBySplit', () => {
  it('selects only the requested split', () => {
    const all = loadScenarios('eval/scenarios');
    for (const s of filterBySplit(all, 'smoke')) expect(s.split).toBe('smoke');
  });

  it('returns nothing for an unused split', () => {
    expect(filterBySplit(loadScenarios('eval/scenarios'), 'nonexistent')).toHaveLength(0);
  });
});

describe('describeBank', () => {
  it('reports the composition so balance can be stated in the report', () => {
    // A bank with only two emergency cases cannot support a meaningful under-triage rate.
    const bank = describeBank(loadScenarios('eval/scenarios'));
    expect(bank.total).toBeGreaterThan(0);
    expect(Object.keys(bank.byGold).length).toBeGreaterThan(0);
    expect(bank.adversarial).toBeGreaterThan(0);
  });

  it('counts an empty bank', () => {
    expect(describeBank([])).toMatchObject({ total: 0, adversarial: 0 });
  });
});
