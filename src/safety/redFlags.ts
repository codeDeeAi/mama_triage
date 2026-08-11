/**
 * Deterministic red-flag register.
 *
 * This is the safety layer, not the reasoning layer. Every rule here runs before and
 * independently of the LLM. If the Anthropic API is unavailable, wrong, or manipulated by
 * a prompt injection, these rules still route an emergency correctly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 *  CLINICAL VERIFICATION GATE
 *
 *  Every rule below is a SCAFFOLD. The patterns show the intended shape and coverage;
 *  the clinical thresholds and the urgency tier attached to each must be verified against
 *  the source guidelines (WHO IMCI, FMOH BEmONC) and signed off by the project's clinical
 *  reviewers before any evaluation run is reported.
 *
 *  Until a rule is verified, `verified` stays false and `source` carries a VERIFY marker.
 *  `assertRegisterVerified()` throws while any rule is unverified, and the evaluation
 *  runner calls it — so unverified clinical logic cannot silently produce published
 *  results. The completed traceability matrix is an appendix in the report.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

import type { Pathway, RedFlagHit, Slots, Urgency } from '../types';
import { isNegated } from './negation';
import { ratchetAll } from './ratchet';

export interface RedFlagRule {
  /** Stable ID recorded in triage_outcomes.red_flags and referenced by eval scenarios. */
  id: string;
  /** Human-readable name, used in clinician-facing rationale and the audit log. */
  label: string;
  /** `unset` means the rule applies to both pathways. */
  pathway: Pathway;
  urgency: Urgency;
  /** Lexical patterns, English and Nigerian Pidgin. Bounded quantifiers only. */
  patterns: RegExp[];
  /** Slot clause: if any listed slot holds the listed value, the rule fires. */
  slot?: Partial<Record<keyof Slots, string | number>>;
  /** Guideline section this rule is traced to. Carries a VERIFY marker until signed off. */
  source: string;
  /** Set true only after clinical reviewer sign-off. */
  verified: boolean;
}

/* ───────────────────────────── maternal postpartum ───────────────────────────── */

const MATERNAL_RULES: RedFlagRule[] = [
  {
    id: 'MAT_CONVULSION',
    label: 'Convulsion / fits (possible eclampsia)',
    pathway: 'maternal',
    urgency: 'emergency',
    slot: { preeclampsia: 'convulsion' },
    patterns: [
      /\bconvuls/i,
      /\bfit(?:s|ting)\b/i,
      /\bseizure/i,
      /\bjerking\b/i,
      /body\s+dey\s+shake/i,
      /\bshaking\s+(?:all\s+over|her\s+body)/i,
    ],
    source: 'VERIFY: FMOH BEmONC — eclampsia / convulsions in pregnancy and postpartum',
    verified: false,
  },
  {
    id: 'MAT_HAEMORRHAGE',
    label: 'Heavy postpartum bleeding',
    pathway: 'maternal',
    urgency: 'emergency',
    slot: { bleeding: 'soaking_pad_hourly' },
    patterns: [
      /soak(?:ing|ed)?[^.]{0,25}(?:pad|cloth|wrapper|towel)/i,
      /(?:pad|cloth|wrapper)[^.]{0,25}soak/i,
      /bleeding[^.]{0,25}(?:heav|plenty|too much|a lot|not stop|won'?t stop)/i,
      /(?:heavy|plenty|too much)[^.]{0,15}(?:bleeding|blood)/i,
      /blood\s+dey\s+(?:rush|comot|pour)/i,
      /\bhaemorrhag|\bhemorrhag/i,
      /passing\s+(?:big\s+)?clots?/i,
    ],
    source: 'VERIFY: FMOH BEmONC — primary postpartum haemorrhage',
    verified: false,
  },
  {
    id: 'MAT_SEVERE_FEVER',
    label: 'High fever with chills (possible puerperal sepsis)',
    pathway: 'maternal',
    urgency: 'emergency',
    slot: { fever: 'high_with_chills' },
    patterns: [
      /fever[^.]{0,25}(?:chills?|shivering|rigors?|shaking)/i,
      /(?:chills?|shivering|rigors?)[^.]{0,25}fever/i,
      /body\s+dey\s+hot[^.]{0,20}(?:shake|shiver|cold)/i,
      /\bhigh\s+(?:fever|temperature)\b/i,
    ],
    source: 'VERIFY: FMOH BEmONC — puerperal sepsis danger signs',
    verified: false,
  },
  {
    id: 'MAT_PREECLAMPSIA_SEVERE',
    label: 'Severe pre-eclampsia warning signs',
    pathway: 'maternal',
    urgency: 'emergency',
    slot: { preeclampsia: 'severe_epigastric_or_swelling' },
    patterns: [
      /(?:severe|bad|terrible)\s+headache/i,
      /headache[^.]{0,30}(?:blurred|blurry|vision|seeing|eyes)/i,
      /(?:blurred|blurry|double)\s+vision/i,
      // Predicate-after-subject phrasing is at least as common in speech as the
      // adjective-first form: "my vision is blurred", not "blurred vision".
      /vision[^.]{0,15}(?:blurr|blurry|poor|bad|double)/i,
      /eyes?[^.]{0,20}(?:blurr|not\s+clear)/i,
      /seeing\s+(?:flashes|spots|lights)/i,
      /(?:pain|hurt)[^.]{0,20}(?:upper|top)\s+(?:stomach|belly|abdomen)/i,
      /epigastric/i,
      /eye\s+dey\s+(?:shine|blur)/i,
      /(?:swelling|swollen)[^.]{0,20}(?:face|hands?)/i,
      /(?:face|hands?)[^.]{0,20}(?:swelling|swollen|swell)/i,
    ],
    source: 'VERIFY: FMOH BEmONC — severe pre-eclampsia warning signs',
    verified: false,
  },
  {
    id: 'MAT_COLLAPSE',
    label: 'Loss of consciousness or collapse',
    pathway: 'maternal',
    urgency: 'emergency',
    patterns: [
      /\bunconscious/i,
      /\bfaint(?:ed|ing)?\b/i,
      /\bcollapse[ds]?\b/i,
      /pass(?:ed)?\s+out/i,
      /\bnot\s+respond(?:ing|ive)/i,
      /she\s+no\s+dey\s+answer/i,
    ],
    source: 'VERIFY: FMOH BEmONC — shock / loss of consciousness',
    verified: false,
  },
  {
    id: 'MAT_BREATHING',
    label: 'Difficulty breathing',
    pathway: 'maternal',
    urgency: 'emergency',
    patterns: [
      /(?:difficulty|trouble|hard|struggling)[^.]{0,15}breath/i,
      /(?:short|shortness)\s+of\s+breath/i,
      /can'?t\s+breath/i,
      /breath\s+dey\s+(?:hard|catch)/i,
    ],
    source: 'VERIFY: FMOH BEmONC — respiratory distress',
    verified: false,
  },
  {
    id: 'MAT_WOUND_INFECTION',
    label: 'Wound or perineal infection signs',
    pathway: 'maternal',
    urgency: 'facility_visit',
    slot: { wound: 'discharge_or_foul_odour' },
    patterns: [
      /(?:wound|stitches?|cut|incision|c-?section)[^.]{0,30}(?:pus|discharge|smell|odour|odor|swollen|red)/i,
      /(?:pus|foul|bad)\s+smell/i,
      /wound\s+dey\s+(?:smell|pain|swell)/i,
      /stitches?\s+(?:open|burst)/i,
    ],
    source: 'VERIFY: FMOH BEmONC — wound infection',
    verified: false,
  },
  {
    id: 'MAT_FOUL_LOCHIA',
    label: 'Foul-smelling vaginal discharge',
    pathway: 'maternal',
    urgency: 'facility_visit',
    patterns: [
      /(?:discharge|lochia|blood)[^.]{0,25}(?:smell|odour|odor|stink)/i,
      /(?:smelly|foul)[^.]{0,15}(?:discharge|lochia)/i,
    ],
    source: 'VERIFY: FMOH BEmONC — endometritis',
    verified: false,
  },
  {
    id: 'MAT_MASTITIS',
    label: 'Breast infection signs',
    pathway: 'maternal',
    urgency: 'facility_visit',
    slot: { breast: 'red_hot_painful_lump' },
    patterns: [
      /breast[^.]{0,30}(?:red|hot|hard\s+lump|swollen|abscess)/i,
      /(?:lump|abscess)[^.]{0,20}breast/i,
      /breast\s+dey\s+(?:pain|hot|hard)/i,
      /\bmastitis\b/i,
    ],
    source: 'VERIFY: FMOH BEmONC — mastitis / breast abscess',
    verified: false,
  },
];

/* ───────────────────────────── neonatal proxy ───────────────────────────── */

const NEONATAL_RULES: RedFlagRule[] = [
  {
    id: 'NEO_NOT_FEEDING',
    label: 'Not feeding / unable to suck',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { feeding: 'unable_to_feed' },
    patterns: [
      /not\s+(?:feeding|sucking|breastfeeding|drinking)/i,
      /(?:refus|reject)(?:e[sd]|ing)?[^.]{0,20}(?:breast|milk|feed)/i,
      /(?:no|never)\s+dey\s+(?:chop|suck|breastfeed|drink)/i,
      /(?:can'?t|cannot|unable\s+to)\s+(?:suck|feed|breastfeed)/i,
      /stopped\s+(?:feeding|sucking|breastfeeding)/i,
      /no\s+fit\s+suck/i,
    ],
    source: 'VERIFY: WHO IMCI — young infant general danger signs (unable to feed)',
    verified: false,
  },
  {
    id: 'NEO_BREATHING_SEVERE',
    label: 'Severe respiratory distress / apnoea',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { breathing: 'grunting_or_apnoea' },
    patterns: [
      /(?:not|stop(?:ped|s)?)\s+breathing/i,
      /(?:blue|purple|dark)[^.]{0,15}(?:lips?|tongue|face|skin)/i,
      /(?:lips?|tongue|face|skin)[^.]{0,15}(?:blue|purple|dark)/i,
      /\bgrunting\b/i,
      /\bapn(?:o|oe)a/i,
      /(?:gasp|struggl)(?:ing|s|ed)?[^.]{0,15}(?:breath|air)/i,
      /chest[^.]{0,15}(?:indrawing|pulling in|sinking)/i,
      /breath\s+dey\s+(?:catch|hard)/i,
    ],
    source: 'VERIFY: WHO IMCI — severe respiratory distress in the young infant',
    verified: false,
  },
  {
    id: 'NEO_CONVULSION',
    label: 'Neonatal convulsion',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { neonatal_convulsions: 'yes' },
    patterns: [
      /\bconvuls/i,
      /\bfit(?:s|ting)\b/i,
      /\bseizure/i,
      /(?:body|hand|leg)[^.]{0,15}(?:jerk|twitch|stiff)/i,
      /pikin\s+dey\s+shake/i,
    ],
    source: 'VERIFY: WHO IMCI — convulsions (general danger sign)',
    verified: false,
  },
  {
    id: 'NEO_LETHARGY',
    label: 'Lethargic or unresponsive',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { activity: 'lethargic_or_unresponsive' },
    patterns: [
      /\blethargic\b/i,
      /\bunconscious/i,
      /(?:not|hardly|barely)\s+(?:moving|waking|responding|wake)/i,
      /(?:very|too)\s+(?:sleepy|weak|floppy|quiet)/i,
      /\bfloppy\b/i,
      /(?:no|never)\s+dey\s+(?:wake|move|cry)/i,
      /(?:difficult|hard)\s+to\s+wake/i,
      /won'?t\s+wake/i,
    ],
    source: 'VERIFY: WHO IMCI — lethargy / unconsciousness (general danger sign)',
    verified: false,
  },
  {
    id: 'NEO_TEMP_EXTREME',
    label: 'Fever or hypothermia in a young infant',
    pathway: 'neonatal',
    urgency: 'emergency',
    patterns: [
      /(?:cold|cool)\s+to\s+touch/i,
      /(?:body|skin)[^.]{0,15}(?:very\s+cold|too\s+cold|freezing)/i,
      /(?:hot|burning)\s+to\s+touch/i,
      /body\s+dey\s+(?:hot|cold)\s+well\s+well/i,
      /\bhypothermi/i,
      /temperature[^.]{0,20}(?:3[89]|4[01])(?:\.\d)?\s*(?:°|deg|c\b)/i,
    ],
    source: 'VERIFY: WHO IMCI — fever or low body temperature in the young infant',
    verified: false,
  },
  {
    id: 'NEO_JAUNDICE_SEVERE',
    label: 'Jaundice extending to palms or soles',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { jaundice: 'to_palms_soles' },
    patterns: [
      /(?:yellow|jaundice)[^.]{0,35}(?:palms?|soles?|feet|hands?)/i,
      /(?:palms?|soles?)[^.]{0,25}yellow/i,
      /whole\s+body[^.]{0,15}yellow/i,
      /body\s+don\s+yellow/i,
    ],
    source: 'VERIFY: WHO IMCI — severe jaundice (palms and soles)',
    verified: false,
  },
  {
    id: 'NEO_BULGING_FONTANELLE',
    label: 'Bulging fontanelle',
    pathway: 'neonatal',
    urgency: 'emergency',
    patterns: [
      /(?:bulging|swollen|raised)[^.]{0,20}(?:fontanelle|soft\s+spot)/i,
      /(?:fontanelle|soft\s+spot)[^.]{0,20}(?:bulging|swollen|raised|pushing|big)/i,
    ],
    source: 'VERIFY: WHO IMCI — bulging fontanelle (possible meningitis)',
    verified: false,
  },
  {
    id: 'NEO_CORD_INFECTION',
    label: 'Umbilical cord infection signs',
    pathway: 'neonatal',
    urgency: 'facility_visit',
    slot: { cord_appearance: 'red_or_discharging' },
    patterns: [
      /(?:cord|navel|umbilic)[^.]{0,30}(?:red|pus|discharge|smell|swollen|bleeding)/i,
      /belly\s+button[^.]{0,25}(?:red|pus|smell)/i,
    ],
    source: 'VERIFY: WHO IMCI — umbilical infection',
    verified: false,
  },
  {
    id: 'NEO_FAST_BREATHING',
    label: 'Fast breathing',
    pathway: 'neonatal',
    urgency: 'facility_visit',
    slot: { breathing: 'fast' },
    patterns: [
      /(?:fast|rapid|quick)[^.]{0,15}breathing/i,
      /breathing[^.]{0,15}(?:fast|quick|rapid)/i,
      /dey\s+breathe\s+fast/i,
    ],
    source: 'VERIFY: WHO IMCI — fast breathing threshold by age',
    verified: false,
  },
  {
    id: 'NEO_JAUNDICE_FACE',
    label: 'Jaundice of face or eyes',
    pathway: 'neonatal',
    urgency: 'facility_visit',
    slot: { jaundice: 'face_only' },
    patterns: [
      /(?:yellow|jaundice)[^.]{0,25}(?:eyes?|face|skin)/i,
      /(?:eyes?|face|skin)[^.]{0,25}yellow/i,
      /eye\s+don\s+yellow/i,
      /\bjaundice\b/i,
    ],
    source: 'VERIFY: WHO IMCI — jaundice assessment',
    verified: false,
  },
  {
    id: 'NEO_REDUCED_FEEDING',
    label: 'Reduced feeding',
    pathway: 'neonatal',
    urgency: 'facility_visit',
    slot: { feeding: 'reduced' },
    patterns: [
      /(?:feeding|sucking|breastfeeding)[^.]{0,20}(?:less|poorly|not well|reduced)/i,
      /(?:not\s+feeding\s+well|feeding\s+badly)/i,
      /no\s+dey\s+chop\s+well/i,
    ],
    source: 'VERIFY: WHO IMCI — feeding problem',
    verified: false,
  },
];

/** The full register. Order is stable so evaluation output is comparable across runs. */
export const RED_FLAGS: readonly RedFlagRule[] = Object.freeze([
  ...MATERNAL_RULES,
  ...NEONATAL_RULES,
]);

/* ───────────────────────────── matching ───────────────────────────── */

/** A rule applies when it targets the session pathway, or either side is unscoped. */
function ruleApplies(rule: RedFlagRule, pathway: Pathway): boolean {
  return rule.pathway === 'unset' || pathway === 'unset' || rule.pathway === pathway;
}

/**
 * Match red flags against free text.
 *
 * Runs on every inbound message before the LLM is called. Matches that are negated in
 * their own clause are discarded (see negation.ts).
 */
export function matchLexical(text: string, pathway: Pathway = 'unset'): RedFlagHit[] {
  const hits: RedFlagHit[] = [];
  if (!text) return hits;

  for (const rule of RED_FLAGS) {
    if (!ruleApplies(rule, pathway)) continue;

    let fired = false;

    for (const pattern of rule.patterns) {
      // `matchAll` requires the global flag and advances past zero-length matches
      // internally, so there is no manual lastIndex handling to get wrong here.
      // Strip-then-add keeps this unconditional: a duplicated flag is a RegExp error.
      const re = new RegExp(pattern.source, pattern.flags.replace(/g/g, '') + 'g');

      for (const m of text.matchAll(re)) {
        if (isNegated(text, m.index, m.index + m[0].length)) continue;
        hits.push({
          id: rule.id,
          urgency: rule.urgency,
          pathway: rule.pathway,
          via: 'lexical',
          evidence: m[0],
          source: rule.source,
        });
        fired = true;
        break;
      }
      if (fired) break; // one hit per rule is enough
    }
  }
  return hits;
}

/**
 * Match red flags against filled clinical slots.
 *
 * Runs after the LLM has extracted slot values. This catches phrasings the lexical pass
 * missed while keeping the escalation decision itself deterministic.
 */
export function matchSlots(slots: Slots, pathway: Pathway = 'unset'): RedFlagHit[] {
  const hits: RedFlagHit[] = [];

  for (const rule of RED_FLAGS) {
    if (!rule.slot || !ruleApplies(rule, pathway)) continue;

    for (const [key, expected] of Object.entries(rule.slot)) {
      const actual = slots[key as keyof Slots];
      if (actual !== undefined && actual === expected) {
        hits.push({
          id: rule.id,
          urgency: rule.urgency,
          pathway: rule.pathway,
          via: 'slot',
          evidence: `${key}=${String(actual)}`,
          source: rule.source,
        });
        break;
      }
    }
  }
  return hits;
}

export interface RedFlagEvaluation {
  hits: RedFlagHit[];
  /** Highest urgency across all hits, or null when nothing fired. */
  urgency: Urgency | null;
}

/**
 * Full deterministic evaluation for one turn: text and slots together, de-duplicated.
 *
 * The returned urgency is the rules layer's opinion. The orchestrator combines it with
 * the LLM's proposal via `ratchet`, so the rules can only ever raise urgency.
 */
export function evaluateRedFlags(input: {
  text?: string;
  slots?: Slots;
  pathway?: Pathway;
}): RedFlagEvaluation {
  const pathway = input.pathway ?? 'unset';
  const all = [
    ...matchLexical(input.text ?? '', pathway),
    ...matchSlots(input.slots ?? {}, pathway),
  ];

  // De-duplicate by rule ID, preferring the lexical hit (it carries the mother's words,
  // which is more useful evidence in the audit log than a slot value).
  const byId = new Map<string, RedFlagHit>();
  for (const hit of all) {
    if (!byId.has(hit.id)) byId.set(hit.id, hit);
  }
  const hits = [...byId.values()];

  // Take the maximum tier present. `ratchetAll` gives one definition of "most urgent"
  // shared with the orchestrator, rather than a second implementation here.
  const urgency = ratchetAll(
    null,
    hits.map((h) => h.urgency),
  );

  return { hits, urgency };
}

/** Look up a rule by ID. Used by the renderer and the evaluation reporter. */
export function getRule(id: string): RedFlagRule | undefined {
  return RED_FLAGS.find((r) => r.id === id);
}

/** Rules still awaiting clinical reviewer sign-off. */
export function unverifiedRules(): RedFlagRule[] {
  return RED_FLAGS.filter((r) => !r.verified);
}

/**
 * Throw if any rule is still unverified.
 *
 * Called by the evaluation runner so that unverified clinical logic cannot silently
 * produce results that end up in the report (plan section 9.1).
 */
export function assertRegisterVerified(): void {
  const pending = unverifiedRules();
  if (pending.length > 0) {
    throw new Error(
      `Red-flag register has ${pending.length} unverified rule(s); clinical reviewer ` +
        `sign-off is required before an evaluation run may be reported. Pending: ` +
        pending.map((r) => r.id).join(', '),
    );
  }
}
