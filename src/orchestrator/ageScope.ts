/**
 * Age scope of the infant pathway.
 *
 * The infant rules, prompts and evaluation scenarios are all drawn from the WHO IMCI chart
 * for the sick young infant, which covers babies from birth up to two months (0 to 59
 * days). Applied to an older baby, that chart is the wrong instrument: an older infant's
 * danger signs, fever thresholds and breathing-rate cut-offs differ, and a "care at home"
 * conclusion reached with young-infant logic is reassurance the system has no basis to
 * give.
 *
 * So the infant pathway is restricted to 0 to 59 days. For an older baby the system does
 * not triage. It says plainly that it cannot assess babies of that age, refers the baby to
 * a health worker, and lists the WHO IMCI general danger signs for a sick child aged two
 * months to five years, which mean going to a facility immediately. It never concludes
 * self-care for an older baby, and the deterministic danger-sign layer still runs on every
 * message, so an emergency described for a baby of any age is still escalated.
 */

import type { TriageDecision } from '../llm/triage';
import { ratchet } from '../safety/ratchet';
import type { Language, Slots } from '../types';

/** Last day of life covered by the IMCI young-infant chart (birth up to two months). */
export const YOUNG_INFANT_MAX_DAYS = 59;

/** True when the infant pathway knows the baby is older than the chart it is built on. */
export function isBeyondInfantScope(slots: Slots): boolean {
  return typeof slots.age_days === 'number' && slots.age_days > YOUNG_INFANT_MAX_DAYS;
}

/**
 * WHO IMCI Chart Booklet (March 2014), "Check for general danger signs" in a sick child
 * aged two months up to five years: not able to drink or breastfeed, vomits everything,
 * has had convulsions, lethargic or unconscious, convulsing now. Any one is a reason to
 * go to a facility immediately.
 */
const OLDER_INFANT_COPY: Record<
  Language,
  { meaning: string; steps: string[]; return_warnings: string[] }
> = {
  en: {
    meaning:
      'I can only check babies under 2 months old. Your baby is older than that, so I ' +
      'cannot tell you whether this is safe to manage at home.',
    steps: [
      'Take your baby to a health worker or clinic to be checked, today if you can.',
      'Keep breastfeeding or giving feeds as usual on the way.',
    ],
    return_warnings: [
      'Your baby cannot drink or breastfeed',
      'Your baby vomits everything',
      'Your baby has had a fit (convulsion)',
      'Your baby is very sleepy or hard to wake',
    ],
  },
  pcm: {
    meaning:
      'I fit check only pikin wey never reach 2 months. Your pikin don pass dat age, so I ' +
      'no fit tell you if e safe to manage am for house.',
    steps: [
      'Carry your pikin go see health worker or clinic make dem check am, today if you fit.',
      'Continue to dey give am breast or im food as usual for road.',
    ],
    return_warnings: [
      'Your pikin no fit drink or suck breast',
      'Your pikin dey vomit everything',
      'Your pikin don get fit (convulsion)',
      'Your pikin dey sleep too much or e hard to wake am',
    ],
  },
};

/**
 * Replace a decision about a baby older than 59 days with a scope referral.
 *
 * The urgency is raised to at least `facility_visit`; an emergency already assigned by
 * the rules, the model or the safety check is kept. The model's own question or
 * conclusion is discarded, because it was reached with young-infant reasoning.
 */
export function applyInfantAgeScope(decision: TriageDecision): TriageDecision {
  // An emergency is already the strongest instruction the system can give, and its own
  // rendering leads with the referral directive. Replacing it with a scope message would
  // only weaken it.
  if (decision.urgency === 'emergency') return decision;

  const urgency = ratchet(decision.urgency, 'facility_visit');
  const language = decision.result.detected_language as Language;
  const copy = OLDER_INFANT_COPY[language] ?? OLDER_INFANT_COPY.en;

  return {
    ...decision,
    urgency,
    escalatedBy: urgency !== decision.urgency ? 'age_scope' : decision.escalatedBy,
    // The referral and its danger signs come from this file, not from a retrieved passage.
    ungrounded: false,
    sources: [
      {
        chunkId: 'static:imci-general-danger-signs',
        publisher: 'WHO IMCI',
        title: 'IMCI Chart Booklet',
        docVersion: 'March 2014',
        section: 'Check for general danger signs (sick child aged 2 months to 5 years)',
      },
    ],
    result: {
      ...decision.result,
      urgency,
      next_action: {
        type: 'conclude',
        meaning: copy.meaning,
        steps: [...copy.steps],
        return_warnings: [...copy.return_warnings],
      },
    },
  };
}

/** Message sent when the mother says at the outset that her baby is two months or older. */
export const OLDER_BABY_SCOPE_MESSAGE: Record<Language, string> = {
  en:
    'I am sorry, I can only check babies under 2 months old.\n\n' +
    'Please take your baby to a health worker or clinic to be checked.\n\n' +
    '*Go to a health facility now* if your baby:\n' +
    '• cannot drink or breastfeed\n' +
    '• vomits everything\n' +
    '• has had a fit (convulsion)\n' +
    '• is very sleepy or hard to wake\n\n' +
    'I am not a doctor. Send /restart if you want to check yourself instead.',
  pcm:
    'Sorry, I fit check only pikin wey never reach 2 months.\n\n' +
    'Abeg carry your pikin go see health worker or clinic make dem check am.\n\n' +
    '*Go health centre now now* if your pikin:\n' +
    '• no fit drink or suck breast\n' +
    '• dey vomit everything\n' +
    '• don get fit (convulsion)\n' +
    '• dey sleep too much or e hard to wake am\n\n' +
    'I no be doctor. Send /restart if you wan check yourself instead.',
};
