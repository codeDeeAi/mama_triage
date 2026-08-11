/**
 * PII redaction applied before any message text is persisted or logged.
 *
 * Chapter 1 §1.4 commits to storing anonymised session transcripts, and Chapter 3 §3.2.3
 * requires all stored session data to be anonymised. `messages.body_redacted` is the only
 * place message text is written, and everything written there passes through here first.
 *
 * The redactor is intentionally aggressive about numbers. A mother writing "call my
 * husband on 08012345678" is far more common than a clinically meaningful 11-digit
 * number, so long digit runs are always masked. Short numbers are preserved, because
 * they carry clinical meaning — "6 days old", "38.5 degrees", "2 weeks postpartum" — and
 * destroying them would make the stored transcripts useless for evaluation.
 *
 * This is a best-effort mitigation, not a guarantee. Free-text de-identification cannot
 * be complete, which is why it sits behind consent, access control, and a retention
 * policy rather than being relied on alone. That limitation belongs in Chapter 5.
 */

/** What was removed from a transcript, for the audit record. */
export interface RedactionReport {
  text: string;
  counts: Record<RedactionKind, number>;
  total: number;
}

export type RedactionKind = 'phone' | 'email' | 'url' | 'long_number' | 'nin';

const PLACEHOLDER: Record<RedactionKind, string> = {
  phone: '[phone]',
  email: '[email]',
  url: '[link]',
  long_number: '[number]',
  nin: '[id]',
};

/**
 * Order matters: email and URL run before the numeric rules so that digits inside an
 * address are not masked first, leaving a mangled fragment behind.
 */
const RULES: ReadonlyArray<{ kind: RedactionKind; pattern: RegExp }> = [
  { kind: 'email', pattern: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi },
  { kind: 'url', pattern: /\bhttps?:\/\/\S+|\bwww\.\S+/gi },

  // Nigerian National Identification Number / BVN: exactly 11 digits, and the commonest
  // 11-digit string a mother might send other than a phone number. The optional filler
  // allows "my NIN is 12345678901" as well as "NIN: 12345678901"; without it the number
  // is still redacted by the generic rule below, but recorded under the wrong kind.
  {
    kind: 'nin',
    pattern: /\b(?:nin|bvn)\b(?:\s+(?:is|na|be))?\s*[:#-]?\s*\d{11}\b/gi,
  },

  // Phone numbers: international (+234...), local (0801...), and spaced/hyphenated forms.
  { kind: 'phone', pattern: /\+\d[\d\s().-]{7,}\d/g },
  { kind: 'phone', pattern: /\b0\d[\d\s().-]{8,}\d\b/g },

  // Any remaining run of 7 or more digits. Clinical values are shorter than this.
  { kind: 'long_number', pattern: /\b\d{7,}\b/g },
];

/**
 * Redact PII from message text.
 *
 * @returns the redacted text plus a count of what was removed, per kind.
 */
export function redact(input: string): RedactionReport {
  const counts: Record<RedactionKind, number> = {
    phone: 0,
    email: 0,
    url: 0,
    long_number: 0,
    nin: 0,
  };

  let text = input ?? '';

  for (const { kind, pattern } of RULES) {
    // Fresh regex per call: the module-level literals carry `g`, and sharing lastIndex
    // across calls would make redaction depend on call order.
    const re = new RegExp(pattern.source, pattern.flags);
    text = text.replace(re, () => {
      counts[kind] += 1;
      return PLACEHOLDER[kind];
    });
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}

/** Convenience wrapper when only the redacted text is needed. */
export function redactText(input: string): string {
  return redact(input).text;
}

/**
 * True when the text still contains something that looks like a phone number.
 *
 * Used as an assertion in the message repository: a body that fails this check must not
 * be written, so a future code path that forgets to redact fails loudly rather than
 * quietly persisting a phone number.
 */
export function looksRedacted(text: string): boolean {
  return !/\b\d{7,}\b/.test(text) && !/\+\d[\d\s().-]{7,}\d/.test(text);
}
