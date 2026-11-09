import {
  isNegated,
  lastClauseDenies,
  matchContainsNegation,
  NEGATION_CUE_LIST,
} from '../../../src/safety/negation';
import { evaluateRedFlags } from '../../../src/safety/redFlags';

/** Helper: locate `needle` in `haystack` and ask whether that match is negated. */
function negatedAt(haystack: string, needle: string): boolean {
  const start = haystack.indexOf(needle);
  if (start < 0) throw new Error(`test setup error: "${needle}" not in "${haystack}"`);
  return isNegated(haystack, start, start + needle.length);
}

/** As `negatedAt`, but targets the LAST occurrence of `needle`. */
function negatedAtLast(haystack: string, needle: string): boolean {
  const start = haystack.lastIndexOf(needle);
  if (start < 0) throw new Error(`test setup error: "${needle}" not in "${haystack}"`);
  return isNegated(haystack, start, start + needle.length);
}

describe('matchContainsNegation', () => {
  it('detects a negation carried inside the match itself', () => {
    expect(matchContainsNegation('no dey chop')).toBe(true);
    expect(matchContainsNegation('not feeding')).toBe(true);
    expect(matchContainsNegation("isn't breathing")).toBe(true);
    expect(matchContainsNegation('cannot suck')).toBe(true);
  });

  it('is false for plain clinical text', () => {
    expect(matchContainsNegation('bleeding heavily')).toBe(false);
    expect(matchContainsNegation('convulsion')).toBe(false);
  });

  it('is stateless across repeated calls', () => {
    // Guards against a lastIndex leak on the shared global regex.
    for (let i = 0; i < 5; i++) {
      expect(matchContainsNegation('not feeding')).toBe(true);
      expect(matchContainsNegation('bleeding heavily')).toBe(false);
    }
  });

  it('exposes its cue list for reviewer documentation', () => {
    expect(NEGATION_CUE_LIST).toContain('no');
    expect(NEGATION_CUE_LIST.length).toBeGreaterThan(5);
  });
});

describe('isNegated — suppression', () => {
  it('suppresses a directly negated symptom', () => {
    expect(negatedAt('she has no fever', 'fever')).toBe(true);
    expect(negatedAt('there is not any bleeding', 'bleeding')).toBe(true);
    expect(negatedAt('she never had convulsion', 'convulsion')).toBe(true);
    expect(negatedAt('mother denies fever', 'fever')).toBe(true);
    expect(negatedAt('without fever', 'fever')).toBe(true);
  });

  it('handles contractions', () => {
    expect(negatedAt("she doesn't have fever", 'fever')).toBe(true);
    expect(negatedAt("baby didn't have convulsion", 'convulsion')).toBe(true);
    expect(negatedAt("she hasn't been bleeding", 'bleeding')).toBe(true);
  });
});

describe('isNegated — the cases that must NOT be suppressed', () => {
  it('does not carry a negation across a comma into the next clause', () => {
    // The single most important case: a reassuring first clause must not mask a
    // genuine emergency in the second.
    expect(negatedAt('no fever, but blood dey rush', 'blood dey rush')).toBe(false);
    expect(negatedAt('no fever, she is bleeding heavily', 'bleeding heavily')).toBe(false);
  });

  it('does not carry a negation across "but"', () => {
    expect(negatedAt('she has no fever but convulsion started', 'convulsion')).toBe(false);
  });

  it('does not carry a negation across a full stop', () => {
    expect(negatedAt('No fever. She is bleeding heavily', 'bleeding heavily')).toBe(false);
  });

  it('does not carry a negation across "however" or "although"', () => {
    expect(negatedAt('no pain however bleeding is heavy', 'bleeding is heavy')).toBe(false);
    expect(negatedAt('no fever although convulsion happened', 'convulsion')).toBe(false);
  });

  it('never suppresses a match whose own text is the danger sign', () => {
    // Pidgin: "e no dey chop" IS the danger sign. The negation belongs to the match.
    expect(negatedAt('e no dey chop since morning', 'no dey chop')).toBe(false);
    expect(negatedAt('the baby is not feeding', 'not feeding')).toBe(false);
  });

  it('does not treat a distant negation as governing the match', () => {
    const text =
      'no problem with the delivery and everything went fine at the clinic bleeding heavy';
    expect(negatedAt(text, 'bleeding heavy')).toBe(false);
  });

  it('leaves an unqualified symptom standing', () => {
    expect(negatedAt('she has fever', 'fever')).toBe(false);
    expect(negatedAt('bleeding heavily since morning', 'bleeding heavily')).toBe(false);
  });

  it('does not suppress on a negation that appears after the match', () => {
    expect(negatedAt('bleeding heavily, no pain', 'bleeding heavily')).toBe(false);
  });
});

describe('isNegated — boundary conditions', () => {
  it('handles a match at the very start of the text', () => {
    expect(negatedAt('fever since yesterday', 'fever')).toBe(false);
  });

  it('handles an empty lookback window', () => {
    expect(isNegated('fever', 0, 5)).toBe(false);
  });

  it('clears the negation for a repeat of the same symptom in a later clause', () => {
    // The first "fever" is negated; the second, after the comma, is not.
    expect(negatedAt('no fever, fever came back', 'fever')).toBe(true);
    expect(negatedAtLast('no fever, fever came back', 'fever')).toBe(false);
  });

  it('suppresses when the negation sits immediately before the match', () => {
    expect(negatedAt('no fever', 'fever')).toBe(true);
  });

  it('handles multiple boundaries, using the nearest', () => {
    expect(negatedAt('no fever, she is fine, bleeding heavy', 'bleeding heavy')).toBe(false);
  });

  it('handles repeated punctuation without stalling', () => {
    expect(negatedAt('no fever... bleeding heavy', 'bleeding heavy')).toBe(false);
  });
});

describe('a qualifier denied in a later clause', () => {
  // Found by the repeated-run evaluation: both sentences fired an emergency rule in every
  // run, because the pattern paired a sign in one clause with a qualifier denied in the next.
  const ids = (text: string, pathway: 'maternal' | 'neonatal'): string[] =>
    evaluateRedFlags({ text, slots: {}, pathway }).hits.map((h) => h.id);

  it('does not read "fever ... but no chills" as fever with chills', () => {
    expect(ids('I have had a mild fever for two days but no chills and no pain', 'maternal')).not.toContain(
      'MAT_SEVERE_FEVER',
    );
  });

  it('does not read "yellow, but his palms are normal" as yellow palms', () => {
    const hits = ids('he is 5 days old and his eyes look a bit yellow, but his palms are normal', 'neonatal');
    expect(hits).not.toContain('NEO_JAUNDICE_SEVERE');
    expect(hits).toContain('NEO_JAUNDICE_FACE');
  });

  it('still fires when the later clause affirms the qualifier', () => {
    expect(ids('I have fever but I am shivering with chills', 'maternal')).toContain('MAT_SEVERE_FEVER');
    expect(ids('his eyes are yellow and his palms are yellow too', 'neonatal')).toContain('NEO_JAUNDICE_SEVERE');
  });

  it('keeps a Pidgin danger sign that is itself a negation', () => {
    expect(ids('e no dey chop at all', 'neonatal')).toContain('NEO_NOT_FEEDING');
  });

  it('only applies when the match crosses a clause boundary', () => {
    expect(lastClauseDenies('fever and chills')).toBe(false);
    expect(lastClauseDenies('fever, but no chills')).toBe(true);
    expect(lastClauseDenies('yellow, but his palms', ' are normal')).toBe(true);
  });
});
