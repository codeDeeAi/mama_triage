/**
 * Rendering a triage decision into WhatsApp messages.
 *
 * The structure is fixed so that outputs are consistent between sessions and scorable by
 * a clinical reviewer. Every conclusion has the same five parts:
 *
 *   1. urgency banner
 *   2. what this means
 *   3. what to do now
 *   4. warning signs to watch for
 *   5. standing disclaimer
 *
 * For an emergency the referral directive is the first thing after the banner and is
 * repeated as the last line. Nothing is rendered above it — a mother scrolling a small
 * screen must not have to read past explanation to find the instruction.
 */

import { disclaimer, referralDirective } from '../safety/fallback';
import { demonstrationOffer } from './demonstrations';
import type { Language, Urgency } from '../types';
import type { TriageDecision } from '../llm/triage';

const BANNER: Record<Urgency, Record<Language, string>> = {
  emergency: {
    en: '🔴 *EMERGENCY — GO NOW*',
    pcm: '🔴 *EMERGENCY — GO NOW NOW*',
  },
  facility_visit: {
    en: '🟠 *SEE A HEALTH WORKER TODAY*',
    pcm: '🟠 *GO SEE HEALTH WORKER TODAY*',
  },
  self_care: {
    en: '🟢 *CARE AT HOME*',
    pcm: '🟢 *CARE FOR HOUSE*',
  },
};

const WATCH_FOR: Record<Language, string> = {
  en: '*Watch for these — if any happen, go for help:*',
  pcm: '*Watch these ones — if any happen, go find help:*',
};

const WHAT_TO_DO: Record<Language, string> = {
  en: '*What to do now:*',
  pcm: '*Wetin to do now:*',
};

/**
 * Render an assessment turn.
 *
 * @returns the message bodies to send, in order. More than one only when the advice is
 *   long enough to need splitting, which the WhatsApp client handles per bubble.
 */
export function renderDecision(decision: TriageDecision): string[] {
  const language = decision.result.detected_language as Language;
  const action = decision.result.next_action;

  // An emergency is communicated immediately, whatever the model intended to do next.
  // This covers two real cases: the model proposes `ask` while itself assigning
  // emergency, and the second-pass safety check raises a mid-assessment turn to
  // emergency. In both, continuing to ask assessment questions would delay the only
  // instruction that matters.
  if (decision.urgency === 'emergency' && action.type === 'ask') {
    return [buildEmergencyMessage(language, false)];
  }

  if (action.type === 'ask') {
    // A demonstration is offered only here, on a question, and only after the emergency
    // branch above has had its chance to return. Some signs — chest indrawing above all —
    // cannot be described to someone who has never been shown one, and the accuracy of
    // her answer is what the slot, and therefore the triage decision, rests on.
    //
    // The link comes from a static register keyed by the domain the model named. The
    // model cannot supply a URL, so it cannot invent one.
    const offer = demonstrationOffer(action.domain, language);
    return offer ? [`${action.question}\n\n${offer}`] : [action.question];
  }

  const lines: string[] = [];
  const isEmergency = decision.urgency === 'emergency';

  lines.push(BANNER[decision.urgency][language]);
  lines.push('');

  // The instruction comes before the explanation for an emergency.
  if (isEmergency) {
    lines.push(referralDirective(language));
    lines.push('');
  }

  lines.push(action.meaning);
  lines.push('');

  lines.push(WHAT_TO_DO[language]);
  action.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('');

  lines.push(WATCH_FOR[language]);
  for (const warning of action.return_warnings) lines.push(`• ${warning}`);
  lines.push('');

  // Repeated last so it is the final thing read, and the last thing on screen.
  if (isEmergency) {
    lines.push(referralDirective(language));
    lines.push('');
  }

  lines.push(disclaimer(language));

  return [lines.join('\n')];
}

/**
 * Deterministic emergency message.
 *
 * Used when an emergency is identified without a model-authored conclusion to render:
 * by the deterministic red-flag scan before any assessment has begun, by a second-pass
 * escalation mid-assessment, or when the model assigns emergency while still asking.
 *
 * The referral directive leads and closes the message. Nothing is rendered above it.
 */
export function buildEmergencyMessage(language: Language, mentalHealth: boolean): string {
  const lines: string[] = [];

  lines.push(BANNER.emergency[language]);
  lines.push('');
  lines.push(referralDirective(language));
  lines.push('');
  lines.push(
    language === 'en'
      ? 'What you have described can be serious and needs to be checked by a health worker straight away. Do not wait to see if it improves.'
      : 'Wetin you talk fit serious, health worker need to check am sharp sharp. No wait make e better first.',
  );

  if (mentalHealth) {
    lines.push('');
    lines.push(
      language === 'en'
        ? 'You are not alone, and what you are feeling can be helped. Please tell a health worker, or someone you trust, how you are feeling today.'
        : 'You no dey alone, and wetin you dey feel get help. Abeg tell health worker, or person wey you trust, how you dey feel today.',
    );
  }

  lines.push('');
  lines.push(referralDirective(language));
  lines.push('');
  lines.push(disclaimer(language));

  return lines.join('\n');
}

/**
 * True when this decision ends the assessment.
 *
 * An emergency always ends it: after issuing a referral directive the system does not
 * continue asking assessment questions.
 */
export function isTerminal(decision: TriageDecision): boolean {
  return decision.urgency === 'emergency' || decision.result.next_action.type === 'conclude';
}

/** Session state a decision should move the session to. */
export function nextState(decision: TriageDecision): 'assessing' | 'completed' | 'escalated' {
  if (decision.urgency === 'emergency') return 'escalated';
  if (decision.result.next_action.type === 'conclude') return 'completed';
  return 'assessing';
}
