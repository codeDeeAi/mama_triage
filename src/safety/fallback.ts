/**
 * Failure fallback.
 *
 * When the LLM is unavailable, times out, returns unparseable output twice, or the
 * circuit breaker is open, the system must NOT go quiet. A triage tool that silently
 * drops a mother's message is more dangerous than one that says "I cannot assess this
 * right now — here is what to watch for."
 *
 * These messages are static, derived from the guideline danger-sign lists, and contain no
 * model-generated content. Like the red-flag register they are scaffolds pending clinical
 * reviewer sign-off (see VERIFY markers in redFlags.ts) and must be checked against the
 * source guidelines before evaluation.
 */

import type { Language, Pathway } from '../types';

export type FallbackReason =
  | 'llm_unavailable'
  | 'llm_timeout'
  | 'llm_invalid_output'
  | 'circuit_open'
  | 'retrieval_failed';

/** Emergency referral directive. Always the first and last thing a mother reads. */
const REFERRAL: Record<Language, string> = {
  en: 'Go to the nearest health facility now. If you cannot travel, call someone to help you immediately.',
  pcm: 'Go the health centre wey dey near you now now. If you no fit go, call person make dem help you sharp sharp.',
};

const DISCLAIMER: Record<Language, string> = {
  en: 'This is guidance, not a diagnosis. If you are worried, go to the nearest health facility.',
  pcm: 'Na guide be dis, no be doctor talk. If you dey worry, go health centre wey dey near you.',
};

const MATERNAL_DANGER_SIGNS: Record<Language, string[]> = {
  en: [
    'Heavy bleeding — soaking more than one pad or cloth in an hour',
    'Fits, convulsions, or fainting',
    'Fever with shivering or chills',
    'Severe headache, blurred vision, or pain in the upper stomach',
    'Difficulty breathing',
    'A wound that is swollen, leaking pus, or smells bad',
  ],
  pcm: [
    'Blood dey rush — pad or cloth dey soak pass one for one hour',
    'Body dey shake, convulsion, or you faint',
    'Fever wey dey make you shiver or cold dey catch you',
    'Headache wey strong, eye dey blur, or belle dey pain you for up side',
    'You no fit breathe well',
    'Wound wey swell, dey bring pus, or dey smell',
  ],
};

const NEONATAL_DANGER_SIGNS: Record<Language, string[]> = {
  en: [
    'Not feeding or unable to suck at the breast',
    'Fits, convulsions, or stiffening of the body',
    'Very sleepy, floppy, or hard to wake',
    'Fast, noisy, or difficult breathing, or blue lips',
    'Body very hot or very cold to touch',
    'Yellow colour reaching the palms of the hands or soles of the feet',
    'Red, swollen, or discharging cord',
  ],
  pcm: [
    'Pikin no dey chop or e no fit suck breast',
    'Body dey shake, convulsion, or body dey stiff',
    'E dey sleep too much, body dey weak, or e no dey wake',
    'E dey breathe fast or hard, or lips don blue',
    'Body dey hot well well or dey cold well well',
    'Yellow don reach im palm or under im leg',
    'Navel don red, swell, or dey bring water',
  ],
};

export interface FallbackMessage {
  /** The text to send, already formatted for WhatsApp. */
  body: string;
  /** Recorded in audit_log alongside the LLM_FAILOVER event. */
  reason: FallbackReason;
  /** Fallback always ends the session safely rather than continuing to assess. */
  terminatesSession: true;
}

/**
 * Build the static danger-sign fallback message.
 *
 * @param pathway  Which danger-sign list to show. `unset` shows both, since we do not
 *                 know who the assessment was for.
 * @param language Mirrors the mother's language.
 * @param reason   Recorded for the audit log and the evaluation report.
 */
export function buildFallback(
  pathway: Pathway,
  language: Language,
  reason: FallbackReason,
): FallbackMessage {
  const lines: string[] = [];

  lines.push(
    language === 'en'
      ? 'I am not able to complete the assessment right now.'
      : 'I no fit finish di assessment now now.',
  );
  lines.push('');
  lines.push(
    language === 'en'
      ? 'Please check for these danger signs:'
      : 'Abeg check for these danger signs:',
  );
  lines.push('');

  const showMaternal = pathway === 'maternal' || pathway === 'unset';
  const showNeonatal = pathway === 'neonatal' || pathway === 'unset';

  if (showMaternal) {
    if (pathway === 'unset') {
      lines.push(language === 'en' ? '*For the mother:*' : '*For mama:*');
    }
    for (const sign of MATERNAL_DANGER_SIGNS[language]) lines.push(`• ${sign}`);
    lines.push('');
  }

  if (showNeonatal) {
    if (pathway === 'unset') {
      lines.push(language === 'en' ? '*For the baby:*' : '*For di pikin:*');
    }
    for (const sign of NEONATAL_DANGER_SIGNS[language]) lines.push(`• ${sign}`);
    lines.push('');
  }

  lines.push(
    language === 'en'
      ? '*If any of these apply, go to the nearest health facility now.*'
      : '*If any of dis one dey happen, go health centre wey dey near you now now.*',
  );
  lines.push('');
  lines.push(DISCLAIMER[language]);

  return { body: lines.join('\n'), reason, terminatesSession: true };
}

/**
 * Emergency referral text, used both by the fallback path and by a deterministic
 * red-flag escalation. Kept here so there is exactly one wording of the most important
 * instruction the system can give.
 */
export function referralDirective(language: Language): string {
  return REFERRAL[language];
}

/** Standing disclaimer appended to every triage conclusion. */
export function disclaimer(language: Language): string {
  return DISCLAIMER[language];
}

/** Danger-sign lists, exported for the renderer's "warning signs to watch for" section. */
export function dangerSigns(pathway: Pathway, language: Language): string[] {
  if (pathway === 'maternal') return [...MATERNAL_DANGER_SIGNS[language]];
  if (pathway === 'neonatal') return [...NEONATAL_DANGER_SIGNS[language]];
  return [...MATERNAL_DANGER_SIGNS[language], ...NEONATAL_DANGER_SIGNS[language]];
}
