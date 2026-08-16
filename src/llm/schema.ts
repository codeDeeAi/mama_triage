/**
 * The structured triage contract.
 *
 * This is the safety-critical boundary between a probabilistic component and a system
 * that gives clinical advice to a mother. Everything crossing it is validated: a response
 * that does not satisfy this schema is not "mostly fine", it is unusable, and the caller
 * retries once and then fails over to the static danger-sign fallback.
 *
 * Using tool use with a declared JSON schema rather than parsing prose is what makes the
 * output scorable — an evaluation cannot compute an under-triage rate over free text.
 */

import { z } from 'zod';
import { URGENCY_VALUES, type Pathway } from '../types';

/** Permitted slot values, kept in step with `Slots` in src/types.ts. */
export const SLOT_ENUMS = {
  // neonatal
  feeding: ['normal', 'reduced', 'unable_to_feed'],
  temperature: ['normal', 'hot_to_touch', 'cold_to_touch'],
  jaundice: ['none', 'face_only', 'to_palms_soles'],
  breathing: ['normal', 'fast', 'chest_indrawing', 'grunting_or_apnoea'],
  activity: ['alert', 'less_active', 'lethargic_or_unresponsive'],
  cord_appearance: ['normal', 'red_or_discharging'],
  neonatal_convulsions: ['no', 'yes'],
  // maternal
  bleeding: ['normal_lochia', 'heavy', 'soaking_pad_hourly', 'clots_with_dizziness'],
  fever: ['none', 'mild', 'high_with_chills'],
  wound: ['healing', 'painful_or_swollen', 'discharge_or_foul_odour'],
  breast: ['normal', 'engorged_or_cracked', 'red_hot_painful_lump'],
  preeclampsia: [
    'none',
    'headache_or_visual',
    'severe_epigastric_or_swelling',
    'convulsion',
  ],
  delivery_mode: ['vaginal', 'caesarean'],
  mood_concerns: ['none', 'low_mood', 'severe'],
} as const satisfies Record<string, readonly string[]>;

/** Numeric slots, validated by range rather than enum. */
export const NUMERIC_SLOTS = {
  age_days: { min: 0, max: 400 },
  days_postpartum: { min: 0, max: 400 },
} as const;

/**
 * Which slots belong to which pathway.
 *
 * Offering all of them on every turn let the model file a mother's own words under a
 * newborn's slot: "I am feeling tired", on a maternal assessment, came back as
 * `activity: less_active` — a neonatal observation about a baby nobody was discussing.
 * That corrupts the record the red-flag rules and the evaluation both read, so the tool
 * schema is built per pathway and the wrong slots are simply not offered.
 *
 * The Zod validator stays permissive across both sets: it guards value correctness, and
 * rejecting a whole turn over a misfiled slot would cost the mother her assessment.
 */
export const PATHWAY_SLOTS = {
  neonatal: [
    'feeding',
    'temperature',
    'jaundice',
    'breathing',
    'activity',
    'age_days',
    'cord_appearance',
    'neonatal_convulsions',
  ],
  maternal: [
    'bleeding',
    'fever',
    'wound',
    'breast',
    'preeclampsia',
    'days_postpartum',
    'delivery_mode',
    'mood_concerns',
  ],
} as const satisfies Record<'neonatal' | 'maternal', readonly string[]>;

const slotShape = Object.fromEntries([
  ...Object.entries(SLOT_ENUMS).map(([key, values]) => [
    key,
    z.enum(values as unknown as [string, ...string[]]).optional(),
  ]),
  ...Object.entries(NUMERIC_SLOTS).map(([key, range]) => [
    key,
    z.number().int().min(range.min).max(range.max).optional(),
  ]),
]);

export const ExtractedSlots = z.object(slotShape).strict();

export const Citation = z.object({
  chunk_id: z.string().min(1),
  /** The specific claim this block supports. Kept for the audit record. */
  claim: z.string().min(1).max(500),
});

export const NextAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ask'),
    /** Which assessment domain the question belongs to. */
    domain: z.string().min(1).max(60),
    question: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('conclude'),
    /** Plain-language explanation of what the finding means. */
    meaning: z.string().min(1).max(600),
    /** Imperative steps. Capped at five: a longer list is not actionable on a phone. */
    steps: z.array(z.string().min(1).max(300)).min(1).max(5),
    /** Signs that mean come back or escalate. Required even for self_care. */
    return_warnings: z.array(z.string().min(1).max(300)).min(1).max(6),
  }),
]);

export const TriageResult = z.object({
  detected_language: z.enum(['en', 'pcm']),
  pathway: z.enum(['maternal', 'neonatal', 'unclear']),
  extracted_slots: ExtractedSlots,
  red_flags: z.array(z.string().max(60)).max(20),
  urgency: z.enum(URGENCY_VALUES as unknown as [string, ...string[]]),
  confidence: z.enum(['low', 'medium', 'high']),
  citations: z.array(Citation).min(1).max(10),
  next_action: NextAction,
  rationale: z.string().min(1).max(2000),
});

export type TriageResult = z.infer<typeof TriageResult>;
export type ExtractedSlots = z.infer<typeof ExtractedSlots>;
export type NextAction = z.infer<typeof NextAction>;
export type Citation = z.infer<typeof Citation>;

export const SafetyVerdict = z
  .object({
    verdict: z.enum(['agree', 'escalate']),
    escalate_to: z.enum(URGENCY_VALUES as unknown as [string, ...string[]]).optional(),
    reason: z.string().min(1).max(500),
  })
  .refine((v) => v.verdict !== 'escalate' || v.escalate_to !== undefined, {
    message: 'escalate_to is required when verdict is "escalate"',
    path: ['escalate_to'],
  });

export type SafetyVerdict = z.infer<typeof SafetyVerdict>;

/* ─────────────────────────── tool schemas for the API ─────────────────────────── */

/**
 * JSON Schema for the `record_triage` tool.
 *
 * Derived from the same constants as the Zod schema so the model's declared contract and
 * the runtime validation cannot drift apart. `next_action` in particular must keep one
 * branch per Zod union member: a model that reads the schema literally will omit whatever
 * the schema does not mark required, and be rejected for it.
 *
 * @param pathway restricts `extracted_slots` to that pathway's slots. Omit only where no
 *   pathway is established — the mother's own answers must not be filed under a newborn's
 *   slots, or the other way round.
 * @param opts.mustConclude removes the `ask` branch entirely, so a model that has every
 *   answer cannot ask a sixth question. Prose asking it to wrap up is a request; removing
 *   the branch is a guarantee.
 */
export function triageToolSchema(
  pathway?: Pathway,
  opts: { mustConclude?: boolean } = {},
): Record<string, unknown> {
  const allowed =
    pathway === 'maternal' || pathway === 'neonatal'
      ? new Set<string>(PATHWAY_SLOTS[pathway])
      : null;

  const slotProperties: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(SLOT_ENUMS)) {
    if (allowed && !allowed.has(key)) continue;
    slotProperties[key] = { type: 'string', enum: [...values] };
  }
  for (const [key, range] of Object.entries(NUMERIC_SLOTS)) {
    if (allowed && !allowed.has(key)) continue;
    slotProperties[key] = { type: 'integer', minimum: range.min, maximum: range.max };
  }

  return {
    type: 'object',
    properties: {
      detected_language: {
        type: 'string',
        enum: ['en', 'pcm'],
        description: 'Language of the mother\'s message. pcm = Nigerian Pidgin.',
      },
      pathway: { type: 'string', enum: ['maternal', 'neonatal', 'unclear'] },
      extracted_slots: {
        type: 'object',
        description:
          'Every clinical slot inferable from this turn, including ones volunteered ' +
          'without being asked.',
        properties: slotProperties,
        additionalProperties: false,
      },
      red_flags: {
        type: 'array',
        items: { type: 'string', maxLength: 60 },
        maxItems: 20,
        description: 'IDs of danger signs that apply, e.g. NEO_NOT_FEEDING.',
      },
      urgency: { type: 'string', enum: [...URGENCY_VALUES] },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      citations: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            chunk_id: {
              type: 'string',
              minLength: 1,
              description: 'Must be a chunk_id from the supplied context blocks.',
            },
            claim: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['chunk_id', 'claim'],
        },
      },
      // A branch each, with its own `required`.
      //
      // This was one loose object requiring only `type`, which told the model that
      // `meaning`, `steps` and `return_warnings` were optional — while the Zod union
      // below rejected a `conclude` that omitted them. A model that reads the schema
      // literally therefore failed the contract on every concluding turn, twice, and the
      // mother got the static fallback at the exact moment she was owed an answer. It
      // only ever "worked" because the previous model inferred the fields from the prose
      // in the system prompt.
      next_action: {
        description: opts.mustConclude
          ? 'Every assessment domain has been answered. Conclude now.'
          : 'Either ask one more question, or conclude the assessment.',
        oneOf: [
          ...(opts.mustConclude
            ? []
            : [
                {
                  type: 'object',
                  description: 'Ask one more question.',
                  properties: {
                    type: { type: 'string', enum: ['ask'] },
                    domain: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 60,
                      description: 'Which assessment domain the question belongs to.',
                    },
                    question: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 500,
                      description:
                        'The single question to put to the mother, in her language.',
                    },
                  },
                  required: ['type', 'domain', 'question'],
                  additionalProperties: false,
                },
              ]),
          {
            type: 'object',
            description: 'Conclude the assessment. All three fields are required.',
            properties: {
              type: { type: 'string', enum: ['conclude'] },
              meaning: {
                type: 'string',
                minLength: 1,
                maxLength: 600,
                description: 'Plain-language explanation of what the finding means.',
              },
              steps: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 300 },
                minItems: 1,
                maxItems: 5,
                description: 'Imperative steps she should take now.',
              },
              return_warnings: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 300 },
                minItems: 1,
                maxItems: 6,
                description:
                  'Signs that mean come back or seek care. Required even for self_care.',
              },
            },
            required: ['type', 'meaning', 'steps', 'return_warnings'],
            additionalProperties: false,
          },
        ],
      },
      rationale: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'Clinical reasoning for the record. Never shown to the mother.',
      },
    },
    required: [
      'detected_language',
      'pathway',
      'extracted_slots',
      'red_flags',
      'urgency',
      'confidence',
      'citations',
      'next_action',
      'rationale',
    ],
  };
}

export function safetyToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['agree', 'escalate'] },
      escalate_to: {
        type: 'string',
        enum: [...URGENCY_VALUES],
        description: 'Required when escalating. Must be more urgent than the proposal.',
      },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
  };
}
