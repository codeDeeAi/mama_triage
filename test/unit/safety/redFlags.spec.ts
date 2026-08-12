import {
  assertRegisterVerified,
  evaluateRedFlags,
  getRule,
  matchLexical,
  matchSlots,
  RED_FLAGS,
  unverifiedRules,
} from '../../../src/safety/redFlags';
import type { Slots } from '../../../src/types';

/** IDs fired by a lexical scan of `text`. */
function ids(text: string, pathway: 'maternal' | 'neonatal' | 'unset' = 'unset'): string[] {
  return matchLexical(text, pathway).map((h) => h.id);
}

describe('register integrity', () => {
  it('has unique rule IDs', () => {
    const seen = new Set<string>();
    for (const rule of RED_FLAGS) {
      expect(seen.has(rule.id)).toBe(false);
      seen.add(rule.id);
    }
  });

  it('gives every rule reviewer-readable examples', () => {
    for (const rule of RED_FLAGS) {
      expect(rule.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every documented example actually fires its own rule', () => {
    // The examples are what the clinical reviewer signs off against, so they must not
    // drift from the patterns. A reviewer approving a phrasing the system does not
    // actually catch is worse than no review at all.
    const failures: string[] = [];
    for (const rule of RED_FLAGS) {
      for (const example of rule.examples) {
        const fired = matchLexical(example, rule.pathway).map((h) => h.id);
        if (!fired.includes(rule.id)) failures.push(`${rule.id}: "${example}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('gives every rule a traceable source and at least one pattern', () => {
    for (const rule of RED_FLAGS) {
      expect(rule.source.length).toBeGreaterThan(0);
      expect(rule.patterns.length).toBeGreaterThan(0);
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it('covers both clinical pathways', () => {
    expect(RED_FLAGS.some((r) => r.pathway === 'maternal')).toBe(true);
    expect(RED_FLAGS.some((r) => r.pathway === 'neonatal')).toBe(true);
  });

  it('carries an emergency rule for each pathway', () => {
    for (const pathway of ['maternal', 'neonatal'] as const) {
      expect(
        RED_FLAGS.some((r) => r.pathway === pathway && r.urgency === 'emergency'),
      ).toBe(true);
    }
  });

  it('looks a rule up by ID', () => {
    expect(getRule('MAT_HAEMORRHAGE')?.urgency).toBe('emergency');
    expect(getRule('NOT_A_RULE')).toBeUndefined();
  });
});

describe('clinical verification gate', () => {
  it('reports rules still awaiting clinician sign-off', () => {
    // Every rule ships unverified. This test will need updating as rules are signed
    // off — that is intentional: it makes sign-off a deliberate, visible act.
    expect(unverifiedRules().length).toBeGreaterThan(0);
  });

  it('refuses to certify the register while any rule is unverified', () => {
    expect(() => assertRegisterVerified()).toThrow(/unverified rule/i);
  });

  it('names the pending rules in the error so the reviewer knows what to check', () => {
    expect(() => assertRegisterVerified()).toThrow(/MAT_CONVULSION/);
  });
});

describe('maternal emergencies (lexical)', () => {
  it.each([
    ['she is having convulsions', 'MAT_CONVULSION'],
    ['my wife started fitting', 'MAT_CONVULSION'],
    ['her body dey shake', 'MAT_CONVULSION'],
    ['I am soaking a pad every hour', 'MAT_HAEMORRHAGE'],
    ['bleeding too much since morning', 'MAT_HAEMORRHAGE'],
    ['blood dey rush comot', 'MAT_HAEMORRHAGE'],
    ['fever with chills and shivering', 'MAT_SEVERE_FEVER'],
    ['I have a severe headache', 'MAT_PREECLAMPSIA_SEVERE'],
    ['my vision is blurred', 'MAT_PREECLAMPSIA_SEVERE'],
    ['she fainted this morning', 'MAT_COLLAPSE'],
    ['she is unconscious', 'MAT_COLLAPSE'],
    ['I am having difficulty breathing', 'MAT_BREATHING'],
  ])('flags %j as %s', (text, expectedId) => {
    expect(ids(text, 'maternal')).toContain(expectedId);
  });

  it('classifies every maternal emergency example as emergency', () => {
    const { urgency } = evaluateRedFlags({
      text: 'she is having convulsions',
      pathway: 'maternal',
    });
    expect(urgency).toBe('emergency');
  });
});

describe('neonatal emergencies (lexical)', () => {
  it.each([
    ['the baby is not feeding', 'NEO_NOT_FEEDING'],
    ['he refuses the breast', 'NEO_NOT_FEEDING'],
    ['pikin no dey chop since morning', 'NEO_NOT_FEEDING'],
    ['baby stopped breathing', 'NEO_BREATHING_SEVERE'],
    ['his lips are blue', 'NEO_BREATHING_SEVERE'],
    ['there is chest indrawing', 'NEO_BREATHING_SEVERE'],
    ['the baby is having convulsions', 'NEO_CONVULSION'],
    ['baby is very sleepy and floppy', 'NEO_LETHARGY'],
    ['he is difficult to wake', 'NEO_LETHARGY'],
    ['e no dey wake at all', 'NEO_LETHARGY'],
    ['the baby is cold to touch', 'NEO_TEMP_EXTREME'],
    ['baby is hot to touch', 'NEO_TEMP_EXTREME'],
    ['yellow has reached his palms', 'NEO_JAUNDICE_SEVERE'],
    ['his soft spot is bulging', 'NEO_BULGING_FONTANELLE'],
  ])('flags %j as %s', (text, expectedId) => {
    expect(ids(text, 'neonatal')).toContain(expectedId);
  });
});

/**
 * Mothers describe symptoms predicate-first at least as often as adjective-first:
 * "his lips are blue", not "blue lips". Patterns written only in the clinical
 * adjective-first form silently miss these, so each is pinned here.
 */
describe('word order — predicate-after-subject phrasing', () => {
  it.each([
    ['his lips are blue', 'neonatal', 'NEO_BREATHING_SEVERE'],
    ['his soft spot is bulging', 'neonatal', 'NEO_BULGING_FONTANELLE'],
    ['his eyes are yellow', 'neonatal', 'NEO_JAUNDICE_FACE'],
    ['his palms are yellow', 'neonatal', 'NEO_JAUNDICE_SEVERE'],
    ['his breathing is fast', 'neonatal', 'NEO_FAST_BREATHING'],
    ['my vision is blurred', 'maternal', 'MAT_PREECLAMPSIA_SEVERE'],
    ['my face is swollen', 'maternal', 'MAT_PREECLAMPSIA_SEVERE'],
    ['the bleeding is heavy', 'maternal', 'MAT_HAEMORRHAGE'],
    ['my breast is red and hot', 'maternal', 'MAT_MASTITIS'],
    ['the wound is swollen', 'maternal', 'MAT_WOUND_INFECTION'],
  ] as const)('flags %j as %s', (text, pathway, expectedId) => {
    expect(ids(text, pathway)).toContain(expectedId);
  });
});

/**
 * Inflection and intervening words. Each of these was a real false negative found by an
 * evaluation scenario: the register listed "feeding" but not "fed", and required the
 * negation to sit adjacent to the verb.
 */
describe('verb forms and intervening words', () => {
  it.each([
    'the baby is not feeding',
    'my baby has not fed at all today',
    'he has not been sucking since morning',
    "she won't feed",
    'the baby is not able to feed',
    'he has not eaten anything',
    'the baby stopped eating',
  ])('flags %j as not feeding', (text) => {
    expect(ids(text, 'neonatal')).toContain('NEO_NOT_FEEDING');
  });

  it.each([
    'I had a fit this morning',
    'she has fits',
    'my wife started fitting',
    'the baby had a fit',
    'she got a fit last night',
  ])('flags %j as a convulsion', (text) => {
    const flags = ids(text, 'unset');
    expect(flags.some((f) => f.endsWith('_CONVULSION'))).toBe(true);
  });

  it('does not treat everyday uses of "fit" as a convulsion', () => {
    expect(ids('the wrapper fits her well', 'maternal')).not.toContain('MAT_CONVULSION');
    expect(ids('she is fit and healthy', 'maternal')).not.toContain('MAT_CONVULSION');
  });

  it('routes "not feeding well" to the lower tier, not to emergency', () => {
    const flags = ids('the baby is not feeding well', 'neonatal');
    expect(flags).toContain('NEO_REDUCED_FEEDING');
    expect(flags).not.toContain('NEO_NOT_FEEDING');
  });

  it.each([
    'he feels cold',
    'the baby feels very cold',
    'his body is very hot',
    'the baby is cold to touch',
  ])('flags %j as a temperature extreme', (text) => {
    expect(ids(text, 'neonatal')).toContain('NEO_TEMP_EXTREME');
  });
});

describe('lower-tier rules', () => {
  it('flags cord infection as a facility visit, not an emergency', () => {
    const { hits, urgency } = evaluateRedFlags({
      text: 'the cord is red and has pus',
      pathway: 'neonatal',
    });
    expect(hits.map((h) => h.id)).toContain('NEO_CORD_INFECTION');
    expect(urgency).toBe('facility_visit');
  });

  it('flags mastitis as a facility visit', () => {
    const { urgency } = evaluateRedFlags({
      text: 'my breast is red and hot with a hard lump',
      pathway: 'maternal',
    });
    expect(urgency).toBe('facility_visit');
  });

  it('escalates to emergency when a higher-tier flag also fires', () => {
    const { urgency } = evaluateRedFlags({
      text: 'the cord is red with pus and the baby is not feeding',
      pathway: 'neonatal',
    });
    expect(urgency).toBe('emergency');
  });
});

describe('negation — no false escalation on reassuring text', () => {
  it.each([
    'she has no fever',
    'there is no bleeding',
    'no convulsions at all',
    'the baby has no jaundice',
    'she does not have a headache',
    'no difficulty breathing',
  ])('does not flag %j', (text) => {
    expect(evaluateRedFlags({ text }).urgency).toBeNull();
  });

  it('does not escalate a completely reassuring report', () => {
    const text =
      'the baby is feeding well, no fever, no convulsions, breathing is normal and he is alert';
    expect(evaluateRedFlags({ text, pathway: 'neonatal' }).urgency).toBeNull();
  });
});

describe('negation — the clinically dangerous case', () => {
  it('still flags a danger sign that follows a reassuring clause', () => {
    const { urgency, hits } = evaluateRedFlags({
      text: 'no fever, but blood dey rush',
      pathway: 'maternal',
    });
    expect(urgency).toBe('emergency');
    expect(hits.map((h) => h.id)).toContain('MAT_HAEMORRHAGE');
  });

  it('flags a mother who minimises before describing an emergency', () => {
    const { urgency } = evaluateRedFlags({
      text: 'it is probably nothing and there is no pain. but she is having convulsions',
      pathway: 'maternal',
    });
    expect(urgency).toBe('emergency');
  });
});

describe('pathway scoping', () => {
  it('does not apply maternal rules during a neonatal assessment', () => {
    expect(ids('my breast is red and hot with a hard lump', 'neonatal')).not.toContain(
      'MAT_MASTITIS',
    );
  });

  it('applies rules from both pathways before one is chosen', () => {
    const flags = ids('she is having convulsions', 'unset');
    expect(flags).toContain('MAT_CONVULSION');
    expect(flags).toContain('NEO_CONVULSION');
  });
});

describe('slot matching', () => {
  it('fires from a filled slot with no matching text', () => {
    const slots: Slots = { feeding: 'unable_to_feed' };
    const hits = matchSlots(slots, 'neonatal');
    expect(hits.map((h) => h.id)).toContain('NEO_NOT_FEEDING');
    expect(hits[0]?.via).toBe('slot');
    expect(hits[0]?.evidence).toBe('feeding=unable_to_feed');
  });

  it('does not fire on a reassuring slot value', () => {
    expect(matchSlots({ feeding: 'normal', breathing: 'normal' }, 'neonatal')).toHaveLength(0);
  });

  it('respects pathway scoping', () => {
    expect(matchSlots({ bleeding: 'soaking_pad_hourly' }, 'neonatal')).toHaveLength(0);
    expect(matchSlots({ bleeding: 'soaking_pad_hourly' }, 'maternal')).toHaveLength(1);
  });

  it('ignores unset slots', () => {
    expect(matchSlots({}, 'maternal')).toHaveLength(0);
  });

  it('defaults to an unscoped pathway, applying rules from both sides', () => {
    expect(matchSlots({ bleeding: 'soaking_pad_hourly' }).map((h) => h.id)).toContain(
      'MAT_HAEMORRHAGE',
    );
    expect(matchSlots({ feeding: 'unable_to_feed' }).map((h) => h.id)).toContain(
      'NEO_NOT_FEEDING',
    );
  });

  it('catches a phrasing the lexical pass missed', () => {
    // The mother's words did not match any pattern, but the LLM extracted the slot.
    const text = 'he just will not take anything at all today';
    expect(ids(text, 'neonatal')).not.toContain('NEO_NOT_FEEDING');

    const { urgency, hits } = evaluateRedFlags({
      text,
      slots: { feeding: 'unable_to_feed' },
      pathway: 'neonatal',
    });
    expect(urgency).toBe('emergency');
    expect(hits.map((h) => h.id)).toContain('NEO_NOT_FEEDING');
  });
});

describe('evaluateRedFlags', () => {
  it('returns null urgency and no hits for benign text', () => {
    const result = evaluateRedFlags({ text: 'how often should I bathe the baby?' });
    expect(result.hits).toHaveLength(0);
    expect(result.urgency).toBeNull();
  });

  it('handles empty and missing input', () => {
    expect(evaluateRedFlags({}).urgency).toBeNull();
    expect(evaluateRedFlags({ text: '' }).urgency).toBeNull();
    expect(matchLexical('')).toHaveLength(0);
  });

  it('de-duplicates a rule that fires both lexically and by slot', () => {
    const result = evaluateRedFlags({
      text: 'the baby is not feeding',
      slots: { feeding: 'unable_to_feed' },
      pathway: 'neonatal',
    });
    const notFeeding = result.hits.filter((h) => h.id === 'NEO_NOT_FEEDING');
    expect(notFeeding).toHaveLength(1);
    // The lexical hit wins: the mother's own words are better audit evidence.
    expect(notFeeding[0]?.via).toBe('lexical');
  });

  it('records evidence and source on every hit', () => {
    const { hits } = evaluateRedFlags({
      text: 'she is having convulsions',
      pathway: 'maternal',
    });
    expect(hits[0]?.evidence.length).toBeGreaterThan(0);
    expect(hits[0]?.source).toMatch(/VERIFY|BEmONC|IMCI/);
  });

  it('fires at most one hit per rule even with repeated matches', () => {
    const { hits } = evaluateRedFlags({
      text: 'convulsions convulsions convulsions',
      pathway: 'maternal',
    });
    expect(hits.filter((h) => h.id === 'MAT_CONVULSION')).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('does not hang on long input', () => {
    const long = 'the baby is fine and feeding well. '.repeat(500);
    const start = Date.now();
    evaluateRedFlags({ text: long, pathway: 'neonatal' });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('is case insensitive', () => {
    expect(ids('SHE IS HAVING CONVULSIONS', 'maternal')).toContain('MAT_CONVULSION');
  });

  it('handles emoji and punctuation noise', () => {
    expect(ids('😭😭 she is having convulsions!!!', 'maternal')).toContain('MAT_CONVULSION');
  });
});
