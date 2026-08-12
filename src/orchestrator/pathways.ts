/**
 * Clinical pathway definitions.
 *
 * These are the deterministic skeleton of the conversation. The state machine walks this
 * list to decide *which* domain to ask about next, which guarantees complete coverage of
 * every assessment domain regardless of what the model does. The model's job is to phrase
 * the question and interpret the answer — not to decide what to ask.
 *
 * That division is the whole architectural argument (IMPLEMENTATION_PLAN.md §3.2): a
 * rule-based system cannot interpret "e no dey chop", and an unconstrained LLM cannot
 * guarantee it asked about breathing.
 *
 * Domain order follows the clinical logic of the source guidelines: the domains that most
 * often carry an emergency come first, so a mother who abandons the conversation halfway
 * has still been asked the questions most likely to matter.
 */

import type { Language, Pathway, SlotKey, Slots } from '../types';

export interface Domain {
  /** Stable ID, passed to the model as `next_action.domain`. */
  id: string;
  /** The slot this domain fills. The domain is complete once it is set. */
  slot: SlotKey;
  /** Shown in the report's assessment-flow figure. */
  label: string;
  /**
   * Fallback question, used only if the model returns an `ask` action without usable
   * question text. Never the primary path — a scripted question is exactly what this
   * system exists to move beyond.
   */
  fallbackQuestion: Record<Language, string>;
}

/** Neonatal proxy pathway — the five domains in Chapter 3, section 3.4.2. */
export const NEONATAL_DOMAINS: readonly Domain[] = Object.freeze([
  {
    id: 'feeding',
    slot: 'feeding',
    label: 'Feeding',
    fallbackQuestion: {
      en: 'Is your baby feeding normally, feeding less than usual, or not able to feed at all?',
      pcm: 'Your pikin dey chop well, dey chop small pass before, or e no fit chop at all?',
    },
  },
  {
    id: 'breathing',
    slot: 'breathing',
    label: 'Breathing',
    fallbackQuestion: {
      en: 'How is your baby breathing? Is it normal, fast, or is the chest pulling in?',
      pcm: 'How your pikin dey breathe? E normal, e dey fast, or im chest dey pull in?',
    },
  },
  {
    id: 'activity',
    slot: 'activity',
    label: 'Activity level',
    fallbackQuestion: {
      en: 'Is your baby awake and moving normally, less active than usual, or very hard to wake?',
      pcm: 'Your pikin dey wake and dey move well, e no dey active like before, or e hard to wake am?',
    },
  },
  {
    id: 'temperature',
    slot: 'temperature',
    label: 'Body temperature',
    fallbackQuestion: {
      en: 'When you touch your baby, does the body feel normal, hot, or cold?',
      pcm: 'When you touch your pikin, im body feel normal, hot, or cold?',
    },
  },
  {
    id: 'jaundice',
    slot: 'jaundice',
    label: 'Skin colour (jaundice)',
    fallbackQuestion: {
      en: 'Is any part of your baby yellow? If yes, is it only the face and eyes, or has it reached the palms and soles?',
      pcm: 'Any part of your pikin body don yellow? If yes, na only face and eye, or e don reach im palm and under im leg?',
    },
  },
]);

/** Maternal postpartum pathway — the danger signs in Chapter 3, section 3.4.3. */
export const MATERNAL_DOMAINS: readonly Domain[] = Object.freeze([
  {
    id: 'bleeding',
    slot: 'bleeding',
    label: 'Bleeding',
    fallbackQuestion: {
      en: 'How much are you bleeding? Is it normal for after birth, heavy, or are you soaking a pad within an hour?',
      pcm: 'How much blood dey comot? E normal for after birth, e heavy, or one pad dey soak inside one hour?',
    },
  },
  {
    id: 'preeclampsia',
    slot: 'preeclampsia',
    label: 'Pre-eclampsia signs',
    fallbackQuestion: {
      en: 'Do you have a severe headache, blurred vision, or pain in your upper stomach?',
      pcm: 'You get headache wey strong, your eye dey blur, or belle dey pain you for up side?',
    },
  },
  {
    id: 'fever',
    slot: 'fever',
    label: 'Fever',
    fallbackQuestion: {
      en: 'Do you have a fever? If yes, are you also getting chills or shivering?',
      pcm: 'You get fever? If yes, cold dey catch you or you dey shiver?',
    },
  },
  {
    id: 'wound',
    slot: 'wound',
    label: 'Wound',
    fallbackQuestion: {
      en: 'How is your wound or stitches? Healing normally, painful and swollen, or leaking with a bad smell?',
      pcm: 'How your wound or stitches dey? E dey heal well, e dey pain and swell, or e dey bring water wey dey smell?',
    },
  },
  {
    id: 'breast',
    slot: 'breast',
    label: 'Breasts',
    fallbackQuestion: {
      en: 'How are your breasts? Normal, full or cracked, or is there a red, hot, painful lump?',
      pcm: 'How your breast dey? E normal, e full or don crack, or lump wey red, hot and dey pain dey there?',
    },
  },
]);

export function domainsFor(pathway: Pathway): readonly Domain[] {
  if (pathway === 'neonatal') return NEONATAL_DOMAINS;
  if (pathway === 'maternal') return MATERNAL_DOMAINS;
  return [];
}

export function domainById(pathway: Pathway, id: string): Domain | undefined {
  return domainsFor(pathway).find((d) => d.id === id);
}

/** Domains still unanswered, in clinical order. */
export function remainingDomains(pathway: Pathway, slots: Slots): Domain[] {
  return domainsFor(pathway).filter((d) => slots[d.slot] === undefined);
}

/** The next domain to ask about, or null when the assessment is complete. */
export function nextDomain(pathway: Pathway, slots: Slots): Domain | null {
  return remainingDomains(pathway, slots)[0] ?? null;
}

export function isAssessmentComplete(pathway: Pathway, slots: Slots): boolean {
  return domainsFor(pathway).length > 0 && remainingDomains(pathway, slots).length === 0;
}

/** How far through the assessment the mother is. Used for progress feedback. */
export function progress(pathway: Pathway, slots: Slots): { answered: number; total: number } {
  const total = domainsFor(pathway).length;
  return { answered: total - remainingDomains(pathway, slots).length, total };
}
