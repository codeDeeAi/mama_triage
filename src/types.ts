/**
 * Shared domain types.
 *
 * These mirror the PostgreSQL enums in migrations/001_sessions.sql exactly. If a value
 * is added here it must be added to the migration (and vice versa) — the DB is the
 * outer guarantee, these types are the inner one.
 */

/** Three-tier urgency classification (Chapter 3, section 3.4.3). */
export type Urgency = 'self_care' | 'facility_visit' | 'emergency';

/** Ordered ranking used by the urgency ratchet. Higher is more urgent. */
export const URGENCY_RANK: Readonly<Record<Urgency, number>> = Object.freeze({
  self_care: 0,
  facility_visit: 1,
  emergency: 2,
});

export const URGENCY_VALUES: readonly Urgency[] = Object.freeze([
  'self_care',
  'facility_visit',
  'emergency',
]);

/** Clinical pathway. `unset` means the mother has not yet chosen who the assessment is for. */
export type Pathway = 'unset' | 'maternal' | 'neonatal';

/**
 * Supported languages. `pcm` is the ISO 639-3 code for Nigerian Pidgin.
 * Hausa, Yoruba and Igbo are explicitly out of scope (Chapter 1, section 1.4.2).
 */
export type Language = 'en' | 'pcm';

export type SessionState =
  | 'new'
  | 'awaiting_consent'
  | 'choosing_pathway'
  | 'assessing'
  | 'confirming'
  | 'completed'
  | 'abandoned'
  | 'escalated';

export type Direction = 'inbound' | 'outbound';

/**
 * Clinical slots collected during an assessment. Every value is a closed enum so that
 * a slot can be matched deterministically against the red-flag register.
 *
 * Neonatal slots follow the five domains in Chapter 3 section 3.4.2; maternal slots
 * follow the danger signs in section 3.4.3.
 */
export interface Slots {
  // --- neonatal proxy pathway ---
  feeding?: 'normal' | 'reduced' | 'unable_to_feed';
  temperature?: 'normal' | 'hot_to_touch' | 'cold_to_touch';
  jaundice?: 'none' | 'face_only' | 'to_palms_soles';
  breathing?: 'normal' | 'fast' | 'chest_indrawing' | 'grunting_or_apnoea';
  activity?: 'alert' | 'less_active' | 'lethargic_or_unresponsive';
  age_days?: number;
  cord_appearance?: 'normal' | 'red_or_discharging';
  neonatal_convulsions?: 'no' | 'yes';

  // --- maternal postpartum pathway ---
  bleeding?: 'normal_lochia' | 'heavy' | 'soaking_pad_hourly' | 'clots_with_dizziness';
  fever?: 'none' | 'mild' | 'high_with_chills';
  wound?: 'healing' | 'painful_or_swollen' | 'discharge_or_foul_odour';
  breast?: 'normal' | 'engorged_or_cracked' | 'red_hot_painful_lump';
  preeclampsia?:
    | 'none'
    | 'headache_or_visual'
    | 'severe_epigastric_or_swelling'
    | 'convulsion';
  days_postpartum?: number;
  delivery_mode?: 'vaginal' | 'caesarean';
  mood_concerns?: 'none' | 'low_mood' | 'severe';
}

export type SlotKey = keyof Slots;

/** A single evidence-bearing red-flag hit. */
export interface RedFlagHit {
  /** Stable identifier, e.g. `NEO_NOT_FEEDING`. Recorded in triage_outcomes.red_flags. */
  id: string;
  urgency: Urgency;
  pathway: Pathway;
  /** How the flag fired: from message text, or from a filled clinical slot. */
  via: 'lexical' | 'slot';
  /** The exact substring or slot value that triggered it — for audit and evaluation. */
  evidence: string;
  /** Guideline section this rule is traced to. */
  source: string;
}
