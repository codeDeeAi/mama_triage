import {
  SafetyVerdict,
  TriageResult,
  safetyToolSchema,
  triageToolSchema,
} from '../../../src/llm/schema';

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detected_language: 'en',
    pathway: 'neonatal',
    extracted_slots: { feeding: 'unable_to_feed', age_days: 6 },
    red_flags: ['NEO_NOT_FEEDING'],
    urgency: 'emergency',
    confidence: 'high',
    citations: [{ chunk_id: 'who-imci#3', claim: 'Not able to feed is a danger sign' }],
    next_action: {
      type: 'conclude',
      meaning: 'Your baby needs to be seen now.',
      steps: ['Go to the nearest health facility now'],
      return_warnings: ['If the baby stops breathing, get help immediately'],
    },
    rationale: 'Unable to feed in a 6-day-old infant is a general danger sign.',
    ...overrides,
  };
}

describe('TriageResult — accepts a well-formed result', () => {
  it('parses a conclusion', () => {
    expect(TriageResult.safeParse(valid()).success).toBe(true);
  });

  it('parses a follow-up question', () => {
    const result = TriageResult.safeParse(
      valid({ next_action: { type: 'ask', domain: 'breathing', question: 'Is the baby breathing normally?' } }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts Pidgin as a detected language', () => {
    expect(TriageResult.safeParse(valid({ detected_language: 'pcm' })).success).toBe(true);
  });
});

describe('TriageResult — rejects malformed output', () => {
  it.each([
    ['an unknown urgency tier', { urgency: 'very_urgent' }],
    ['an unknown language', { detected_language: 'yo' }],
    ['an unknown confidence value', { confidence: 'certain' }],
    ['a missing rationale', { rationale: undefined }],
    ['an unknown next_action type', { next_action: { type: 'wait' } }],
  ])('rejects %s', (_label, override) => {
    expect(TriageResult.safeParse(valid(override)).success).toBe(false);
  });

  it('requires at least one citation', () => {
    expect(TriageResult.safeParse(valid({ citations: [] })).success).toBe(false);
  });

  it('rejects a slot value outside the permitted enum', () => {
    // A hallucinated slot value would flow into the red-flag matcher and silently fail
    // to match anything, so it must be rejected at the boundary.
    expect(
      TriageResult.safeParse(valid({ extracted_slots: { feeding: 'a bit poorly' } })).success,
    ).toBe(false);
  });

  it('rejects an unknown slot name', () => {
    expect(
      TriageResult.safeParse(valid({ extracted_slots: { invented_slot: 'x' } })).success,
    ).toBe(false);
  });

  it('rejects an out-of-range numeric slot', () => {
    expect(TriageResult.safeParse(valid({ extracted_slots: { age_days: -1 } })).success).toBe(false);
    expect(TriageResult.safeParse(valid({ extracted_slots: { age_days: 9999 } })).success).toBe(false);
  });

  it('caps advice steps at five', () => {
    const six = Array.from({ length: 6 }, (_, i) => `step ${i}`);
    expect(
      TriageResult.safeParse(
        valid({
          next_action: {
            type: 'conclude',
            meaning: 'x',
            steps: six,
            return_warnings: ['w'],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('requires return warnings on every conclusion', () => {
    // Including self_care: advice with no "come back if" is incomplete advice.
    expect(
      TriageResult.safeParse(
        valid({
          urgency: 'self_care',
          next_action: { type: 'conclude', meaning: 'x', steps: ['rest'], return_warnings: [] },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a conclusion missing its steps', () => {
    expect(
      TriageResult.safeParse(
        valid({ next_action: { type: 'conclude', meaning: 'x', return_warnings: ['w'] } }),
      ).success,
    ).toBe(false);
  });

  it('rejects entirely unstructured output', () => {
    expect(TriageResult.safeParse('the baby seems unwell').success).toBe(false);
    expect(TriageResult.safeParse(null).success).toBe(false);
    expect(TriageResult.safeParse({}).success).toBe(false);
  });
});

describe('SafetyVerdict', () => {
  it('accepts agreement', () => {
    expect(SafetyVerdict.safeParse({ verdict: 'agree', reason: 'nothing missed' }).success).toBe(true);
  });

  it('accepts an escalation with a target', () => {
    expect(
      SafetyVerdict.safeParse({
        verdict: 'escalate',
        escalate_to: 'emergency',
        reason: 'infant not feeding was not acted on',
      }).success,
    ).toBe(true);
  });

  it('rejects an escalation with no target', () => {
    const result = SafetyVerdict.safeParse({ verdict: 'escalate', reason: 'something' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown verdict', () => {
    expect(SafetyVerdict.safeParse({ verdict: 'lower', reason: 'x' }).success).toBe(false);
  });
});

describe('tool schemas', () => {
  it('declares every required triage field', () => {
    const schema = triageToolSchema() as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'detected_language',
        'pathway',
        'urgency',
        'confidence',
        'citations',
        'next_action',
        'rationale',
      ]),
    );
  });

  it('constrains slots to the same enums as the Zod schema', () => {
    // Both are generated from SLOT_ENUMS, so the model's declared contract and the
    // runtime validation cannot drift apart.
    const schema = triageToolSchema() as {
      properties: { extracted_slots: { properties: Record<string, { enum?: string[] }> } };
    };
    expect(schema.properties.extracted_slots.properties.feeding?.enum).toEqual([
      'normal',
      'reduced',
      'unable_to_feed',
    ]);
  });

  it('forbids additional slot properties', () => {
    const schema = triageToolSchema() as {
      properties: { extracted_slots: { additionalProperties: boolean } };
    };
    expect(schema.properties.extracted_slots.additionalProperties).toBe(false);
  });

  it('requires at least one citation', () => {
    const schema = triageToolSchema() as {
      properties: { citations: { minItems: number } };
    };
    expect(schema.properties.citations.minItems).toBe(1);
  });

  it('declares the safety verdict schema', () => {
    const schema = safetyToolSchema() as { required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['verdict', 'reason']));
  });
});

/**
 * The drift that broke production.
 *
 * `next_action` was declared as one loose object requiring only `type`, while the Zod
 * union required `meaning`, `steps` and `return_warnings` for a conclusion. A model that
 * reads the schema literally omitted them, failed validation twice, and the mother got
 * the static danger-sign fallback on the exact turn she was owed an answer.
 *
 * These assert the two descriptions of `next_action` agree, so the contract the model is
 * given can never again promise less than the validator demands.
 */
describe('tool schema and validator agree on next_action', () => {
  interface Branch {
    properties: Record<string, unknown>;
    required: string[];
  }
  const branches = (): Branch[] =>
    (triageToolSchema() as { properties: { next_action: { oneOf: Branch[] } } }).properties
      .next_action.oneOf;

  const branchFor = (type: string): Branch => {
    const found = branches().find(
      (b) => (b.properties.type as { enum?: string[] }).enum?.[0] === type,
    );
    if (!found) throw new Error(`no ${type} branch`);
    return found;
  };

  it('offers exactly one branch per Zod union member', () => {
    expect(branches()).toHaveLength(2);
    expect(
      branches().map((b) => (b.properties.type as { enum: string[] }).enum[0]).sort(),
    ).toEqual(['ask', 'conclude']);
  });

  it('marks every field the validator requires for a conclusion', () => {
    expect(branchFor('conclude').required.sort()).toEqual([
      'meaning',
      'return_warnings',
      'steps',
      'type',
    ]);
  });

  it('marks every field the validator requires for a question', () => {
    expect(branchFor('ask').required.sort()).toEqual(['domain', 'question', 'type']);
  });

  /**
   * The property that actually matters: anything the schema permits, Zod must accept.
   * Building the minimum payload each branch declares and validating it is exactly what
   * would have caught the original bug.
   */
  it.each(['ask', 'conclude'])('accepts the minimum payload the %s branch declares', (type) => {
    const minimum: Record<string, Record<string, unknown>> = {
      ask: { type: 'ask', domain: 'bleeding', question: 'How much are you bleeding?' },
      conclude: {
        type: 'conclude',
        meaning: 'This can be managed at home.',
        steps: ['Rest and drink fluids'],
        return_warnings: ['Go for help if the bleeding increases'],
      },
    };
    expect(TriageResult.safeParse(valid({ next_action: minimum[type] })).success).toBe(true);
  });

  it('rejects a conclusion missing what the branch marks required', () => {
    // The exact shape returned when the schema said only `type` was needed.
    expect(TriageResult.safeParse(valid({ next_action: { type: 'conclude' } })).success).toBe(
      false,
    );
  });
});

describe('forcing a conclusion', () => {
  const types = (opts?: { mustConclude?: boolean }): string[] =>
    (
      triageToolSchema('maternal', opts) as {
        properties: { next_action: { oneOf: Array<{ properties: { type: { enum: string[] } } }> } };
      }
    ).properties.next_action.oneOf.map((b) => String(b.properties.type.enum[0]));

  it('offers both branches while domains are outstanding', () => {
    expect(types().sort()).toEqual(['ask', 'conclude']);
  });

  it('withdraws the ask branch once every domain is answered', () => {
    // Prose asking the model to wrap up is a request it ignored for five turns running.
    // Removing the branch is a guarantee.
    expect(types({ mustConclude: true })).toEqual(['conclude']);
  });
});

describe('pathway-scoped slots', () => {
  const slotsFor = (pathway?: 'maternal' | 'neonatal'): string[] =>
    Object.keys(
      (
        triageToolSchema(pathway) as {
          properties: { extracted_slots: { properties: Record<string, unknown> } };
        }
      ).properties.extracted_slots.properties,
    );

  it('does not offer newborn slots on a maternal assessment', () => {
    // "I am feeling tired", from the mother, came back as activity=less_active — an
    // observation about a baby nobody was discussing.
    const maternal = slotsFor('maternal');
    expect(maternal).toContain('bleeding');
    expect(maternal).toContain('days_postpartum');
    expect(maternal).not.toContain('activity');
    expect(maternal).not.toContain('feeding');
    expect(maternal).not.toContain('age_days');
  });

  it('does not offer maternal slots on a newborn assessment', () => {
    const neonatal = slotsFor('neonatal');
    expect(neonatal).toContain('feeding');
    expect(neonatal).toContain('age_days');
    expect(neonatal).not.toContain('bleeding');
    expect(neonatal).not.toContain('preeclampsia');
  });

  it('offers every slot when no pathway is established', () => {
    expect(slotsFor()).toEqual(
      expect.arrayContaining(['bleeding', 'feeding', 'age_days', 'days_postpartum']),
    );
  });

  it('covers every slot between the two pathways, so none is unreachable', () => {
    const union = [...new Set([...slotsFor('maternal'), ...slotsFor('neonatal')])];
    expect(union.sort()).toEqual(slotsFor().sort());
  });
});
