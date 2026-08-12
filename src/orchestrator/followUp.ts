/**
 * Follow-up scheduling rules.
 *
 * Intervals are taken verbatim from the WHO IMCI young-infant chart, "WHEN TO RETURN —
 * Follow up visit":
 *
 *     If the infant has:            Return for first follow-up in:
 *     JAUNDICE                      1 day
 *     LOCAL BACTERIAL INFECTION     2 days
 *     FEEDING PROBLEM               2 days
 *     THRUSH                        2 days
 *     DIARRHOEA                     2 days
 *     LOW WEIGHT FOR AGE            14 days
 *
 * Pure functions, so the mapping from a triage outcome to an interval is testable without
 * a database or a clock.
 */

import type { Pathway, Slots, Urgency } from '../types';

export interface FollowUpPlan {
  /** Stable identifier for the classification that triggered this. */
  reason: string;
  intervalDays: number;
  /** Shown to a reviewer; not sent to the mother. */
  rationale: string;
}

/**
 * Decide what follow-up, if any, a completed assessment warrants.
 *
 * Two deliberate omissions:
 *
 *   - **Emergency outcomes get no scheduled reminder.** She has been told to go now. A
 *     message two days later would be the wrong intervention, and could read as though
 *     the referral were optional. If she is still in the system in two days, that is a
 *     clinical failure a reminder cannot fix.
 *   - **Self-care outcomes get none either.** IMCI pairs the green classification with
 *     "when to return immediately" advice, which the renderer already includes in every
 *     conclusion, rather than a scheduled visit.
 */
export function planFollowUp(input: {
  urgency: Urgency;
  pathway: Pathway;
  slots: Slots;
}): FollowUpPlan | null {
  if (input.urgency !== 'facility_visit') return null;
  if (input.pathway !== 'neonatal') {
    // The maternal intervals are not specified by IMCI, and the FMOH postnatal guideline
    // is not yet sourced. Scheduling one on a guess would be inventing clinical advice.
    return null;
  }

  const { slots } = input;

  // Jaundice is the shortest interval, so it wins when several apply.
  if (slots.jaundice === 'face_only') {
    return {
      reason: 'jaundice',
      intervalDays: 1,
      rationale: 'WHO IMCI: JAUNDICE — return for first follow-up in 1 day',
    };
  }

  if (slots.cord_appearance === 'red_or_discharging') {
    return {
      reason: 'local_bacterial_infection',
      intervalDays: 2,
      rationale: 'WHO IMCI: LOCAL BACTERIAL INFECTION — return for follow-up in 2 days',
    };
  }

  if (slots.feeding === 'reduced') {
    return {
      reason: 'feeding_problem',
      intervalDays: 2,
      rationale: 'WHO IMCI: FEEDING PROBLEM — return for follow-up in 2 days',
    };
  }

  // A facility-visit classification with no specific trigger still warrants the general
  // 2-day interval: the chart's shortest routine follow-up.
  return {
    reason: 'facility_visit_general',
    intervalDays: 2,
    rationale: 'WHO IMCI: routine follow-up for a yellow classification — 2 days',
  };
}

/** When the reminder is due, given the time the assessment concluded. */
export function dueAt(plan: FollowUpPlan, from: Date): Date {
  const due = new Date(from);
  due.setUTCDate(due.getUTCDate() + plan.intervalDays);
  // Nudge to a reasonable hour rather than firing at 03:00 because that is when she
  // happened to message. WAT is UTC+1, so 09:00 local is 08:00 UTC.
  due.setUTCHours(8, 0, 0, 0);
  // If that has already passed for a same-day interval, send in the morning after.
  if (due.getTime() <= from.getTime()) {
    due.setUTCDate(due.getUTCDate() + 1);
  }
  return due;
}

/**
 * The reminder text.
 *
 * It asks her to come back rather than attempting triage, because a reminder is one-way
 * until she replies. It repeats the referral instruction, since her situation may have
 * worsened since the assessment.
 */
export function followUpMessage(
  displayName: string | null,
  language: 'en' | 'pcm',
): string {
  const name = displayName ? ` ${displayName}` : '';
  return language === 'pcm'
    ? `Hello${name}, na MamaTriage.\n\nWe check your pikin small time ago and I tell you ` +
        `make you see health worker. How your pikin dey now?\n\nReply make I ask you ` +
        `small questions.\n\nIf anything don worse, abeg go health centre wey dey near ` +
        `you now now.`
    : `Hello${name}, this is MamaTriage.\n\nWe checked your baby recently and I advised ` +
        `you to see a health worker. How is your baby now?\n\nReply and I will ask a few ` +
        `short questions.\n\nIf anything has become worse, please go to your nearest ` +
        `health facility now.`;
}
