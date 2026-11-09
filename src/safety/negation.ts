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

  // A match that spans two clauses pairs a sign in the first clause with a qualifier in
  // the last ("mild fever for two days but no chills", "eyes a bit yellow, but his palms
  // are normal"). If that last clause denies the qualifier, the pairing is false and the
  // rule must not fire: the evaluation found exactly these two sentences escalated to
  // emergency in every run. Checked before the rule below, because a negation in a later
  // clause is a denial, not a Pidgin danger sign such as "e no dey chop".
  // The qualifier's own clause runs on past the match ("his palms | are normal"), so the
  // rest of that clause is read too.
  const rest = text.slice(matchEnd, matchEnd + LOOKBACK_CHARS);
  const restBoundary = rest.search(CLAUSE_BOUNDARY_ONCE);
  const clauseTail = restBoundary >= 0 ? rest.slice(0, restBoundary) : rest;
  if (lastClauseDenies(matchedText, clauseTail)) return true;

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

/** Non-global twin of CLAUSE_BOUNDARY, for `String.search`. */
const CLAUSE_BOUNDARY_ONCE = new RegExp(CLAUSE_BOUNDARY.source, 'i');

/** Words that state a finding is normal, which deny it as surely as "no" does. */
const NORMALITY_PATTERN = /\b(?:normal|fine|okay|ok|clear|well)\b/i;

/**
 * True when the matched span crosses a clause boundary and its final clause — the one
 * holding the qualifying sign — is negated or described as normal.
 */
export function lastClauseDenies(matchedText: string, clauseTail = ''): boolean {
  const boundary = lastIndexOfBoundary(matchedText);
  if (boundary < 0) return false;
  const lastClause = matchedText.slice(boundary + 1) + clauseTail;
  NEGATION_PATTERN.lastIndex = 0;
  return NEGATION_PATTERN.test(lastClause) || NORMALITY_PATTERN.test(lastClause);
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
