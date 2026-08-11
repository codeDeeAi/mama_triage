/**
 * Negation guard for the red-flag matcher.
 *
 * Without this, "she has no fever and no bleeding" fires both the fever and the
 * haemorrhage rules, and every session escalates to EMERGENCY — which would make the
 * system useless and, worse, train reviewers to ignore its escalations.
 *
 * The guard is deliberately conservative. It only suppresses a match when a negation cue
 * appears *immediately before* it in the same clause. Anything else — a negation in a
 * previous clause, a negation after the match, an ambiguous construction — leaves the
 * match standing, because a false positive costs an unnecessary referral while a false
 * negative costs a missed emergency.
 *
 * Nigerian Pidgin needs special care: "e no dey chop" (the baby is not eating) is itself
 * a danger sign, and its pattern contains the negation. Matches that carry their own
 * negation are therefore never suppressed — see `matchContainsNegation`.
 */

/** How far back to look for a negation cue, in characters. */
const LOOKBACK_CHARS = 40;

/**
 * Negation cues in English and Nigerian Pidgin.
 * Matched as whole words, case-insensitively.
 */
const NEGATION_CUES = [
  'no',
  'not',
  'never',
  'none',
  'nothing',
  'without',
  'denies',
  'deny',
  'negative',
  'cannot',
  'nor',
  'neither',
  "n't", // handled separately as a suffix — see NEGATION_PATTERN
] as const;

/**
 * Whole-word negation cues, plus any contraction ending in "n't"
 * (didn't, isn't, hasn't, won't, can't ...).
 */
const NEGATION_PATTERN = /\b(?:no|not|never|none|nothing|without|denies|deny|negative|cannot|nor|neither)\b|\w+n't\b/gi;

/**
 * Clause boundaries. A negation does not carry across one of these, so
 * "no fever, but blood dey rush" leaves the haemorrhage match standing.
 */
const CLAUSE_BOUNDARY = /[,.;:!?]|\b(?:but|however|though|although|except|still|yet|and then)\b/gi;

/** True when the matched text itself contains a negation (e.g. Pidgin "no dey chop"). */
export function matchContainsNegation(matchedText: string): boolean {
  NEGATION_PATTERN.lastIndex = 0;
  return NEGATION_PATTERN.test(matchedText);
}

/**
 * Decide whether a match at [matchStart, matchEnd) in `text` is negated.
 *
 * @param text        The full message text.
 * @param matchStart  Index of the first character of the match.
 * @param matchEnd    Index one past the last character of the match.
 */
export function isNegated(text: string, matchStart: number, matchEnd: number): boolean {
  const matchedText = text.slice(matchStart, matchEnd);

  // The danger sign is the negation ("baby no dey chop"). Never suppress.
  if (matchContainsNegation(matchedText)) return false;

  const windowStart = Math.max(0, matchStart - LOOKBACK_CHARS);
  let window = text.slice(windowStart, matchStart);

  // Trim to the current clause: anything before the last boundary belongs to a
  // different statement and its negation does not reach this match.
  const lastBoundary = lastIndexOfBoundary(window);
  if (lastBoundary >= 0) {
    window = window.slice(lastBoundary + 1);
  }

  NEGATION_PATTERN.lastIndex = 0;
  return NEGATION_PATTERN.test(window);
}

/** Index of the last clause boundary in `segment`, or -1 if there is none. */
function lastIndexOfBoundary(segment: string): number {
  // `matchAll` advances past zero-length matches internally and does not share
  // lastIndex state with other callers, so this cannot stall or leak between calls.
  const matches = [...segment.matchAll(CLAUSE_BOUNDARY)];
  const last = matches[matches.length - 1];
  return last === undefined ? -1 : last.index + last[0].length - 1;
}

/** Exposed for tests and documentation. */
export const NEGATION_CUE_LIST: readonly string[] = NEGATION_CUES;
