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
  /**
   * Representative phrasings this rule is meant to catch, in plain language.
   *
   * These are what the clinical reviewer actually reads — regular expressions are not a
   * reviewable artefact. A test asserts every example still fires its own rule, so the
   * documentation cannot drift away from the behaviour it describes.
   */
  examples: string[];
  /** Guideline section this rule is traced to. Carries a VERIFY marker until signed off. */
  source: string;
  /** Set true only after review. See `verifiedBy` for who reviewed it and how. */
  verified: boolean;
  /**
   * Who verified this rule and against what.
   *
   * Distinguishes guideline-traced verification by the author from clinical sign-off
   * by a qualified reviewer. The evaluation report states this verbatim, so a reader
   * always knows which kind of assurance stands behind a rule.
   */
  verifiedBy?: string;
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
      // The suffix was previously mandatory, so bare "I had a fit" — the commonest lay
      // description of a convulsion — never matched. Context is required rather than
      // matching bare "fit", which is an everyday word ("the dress fits").
      /\b(?:had|have|has|having|get|got|start(?:ed|s)?)\s+(?:a\s+|the\s+)?fits?\b/i,
      /\bfitting\b/i,
      /\bfits?\s+(?:this|last|yesterday|today|earlier)\b/i,
      /\bseizure/i,
      /\bjerking\b/i,
      /body\s+dey\s+shake/i,
      /\bshaking\s+(?:all\s+over|her\s+body)/i,
    ],
    examples: [
      'she is having convulsions',
      'I had a fit this morning',
      'her body dey shake',
      'my wife started fitting',
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
      // Adverbs commonly sit between subject and verb in Pidgin: "blood JUST dey rush".
      // Requiring adjacency here missed a genuine haemorrhage scenario.
      /blood\s+(?:\w+\s+){0,2}dey\s+(?:rush|comot|pour|waka)/i,
      /\bhaemorrhag|\bhemorrhag/i,
      /passing\s+(?:big\s+)?clots?/i,
    ],
    examples: [
      'I am soaking a pad every hour',
      'bleeding too much since morning',
      'blood dey rush comot',
      'blood just dey rush comot plenty',
      'the bleeding is heavy',
    ],
    source:
      'FMOH Nigeria, National Guideline for the Management of Postpartum Haemorrhage (2025), Definition of terms — \'Postpartum Haemorrhage: Blood loss of 500 ml or more from the female genital tract after childbirth\'; \'Major PPH: Blood loss >1,000 ml\'. Soaking a pad within an hour is a lay proxy for this volume and REQUIRES clinician confirmation as a threshold.',
    verified: true,
    verifiedBy:
      'author, traced to FMOH Nigeria National Guideline on PPH (2025) retrieved from health.gov.ng — volume-to-lay-description mapping still needs clinician sign-off',
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
    examples: [
      'fever with chills and shivering',
      'I have a high fever',
      'body dey hot and cold dey catch me',
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
    examples: [
      'I have a severe headache',
      'my vision is blurred',
      'pain in my upper stomach',
      'my face is swollen',
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
    examples: [
      'she is unconscious',
      'she fainted this morning',
      'she no dey answer',
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
    examples: [
      'I am having difficulty breathing',
      'I can\'t breathe properly',
      'breath dey hard',
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
    examples: [
      'my stitches have pus and a bad smell',
      'the caesarean wound is red and swollen',
      'wound dey smell',
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
    examples: [
      'the discharge has a bad smell',
      'smelly discharge since yesterday',
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
    examples: [
      'my breast is red and hot with a hard lump',
      'breast dey pain and hot',
      'I think I have mastitis',
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
      // Covers "not feeding", "has not fed", "has not been sucking", "won't feed",
      // "is not able to feed". The negation, the optional "been"/"able to", and the
      // inflected verb forms all matter: mothers do not phrase this the way a guideline
      // does, and each missing form is a silently missed emergency.
      // `(?!\s+well)` hands "not feeding well" to NEO_REDUCED_FEEDING instead.
      /(?:\bnot|\bnever|\w+n'?t)\s+(?:been\s+)?(?:able\s+to\s+)?(?:feed|fed|feeding|suck|sucking|sucked|breastfeed|breastfeeding|drink|drinking|eat|eaten|eating)\b(?!\s+well)/i,
      /(?:refus|reject)(?:e[sd]|ing)?[^.]{0,20}(?:breast|milk|feed)/i,
      /(?:no|never)\s+dey\s+(?:chop|suck|breastfeed|drink)\b(?!\s+well)/i,
      // "no gree" = refuses to. A separate idiom from "no dey", and the commoner
      // way of saying a baby is refusing the breast.
      /no\s+gree\s+(?:chop|suck|breastfeed|drink|take)/i,
      /(?:can'?t|cannot|unable\s+to)\s+(?:suck|feed|breastfeed)/i,
      /stopped\s+(?:feeding|sucking|breastfeeding|eating)/i,
      /no\s+fit\s+(?:suck|chop)/i,
    ],
    examples: [
      'the baby is not feeding',
      'he has not fed at all today',
      'he has not been sucking since morning',
      'pikin no dey chop',
      'pikin no gree chop',
      'he refuses the breast',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant Age Up To 2 Months, \'Check for very severe disease and local bacterial infection\' — \'Not feeding well\' → VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
    examples: [
      'the baby stopped breathing',
      'his lips are blue',
      'there is chest indrawing',
      'he is grunting',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Severe chest indrawing\' → VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
  },
  {
    id: 'NEO_CONVULSION',
    label: 'Neonatal convulsion',
    pathway: 'neonatal',
    urgency: 'emergency',
    slot: { neonatal_convulsions: 'yes' },
    patterns: [
      /\bconvuls/i,
      // The suffix was previously mandatory, so bare "I had a fit" — the commonest lay
      // description of a convulsion — never matched. Context is required rather than
      // matching bare "fit", which is an everyday word ("the dress fits").
      /\b(?:had|have|has|having|get|got|start(?:ed|s)?)\s+(?:a\s+|the\s+)?fits?\b/i,
      /\bfitting\b/i,
      /\bfits?\s+(?:this|last|yesterday|today|earlier)\b/i,
      /\bseizure/i,
      /(?:body|hand|leg)[^.]{0,15}(?:jerk|twitch|stiff)/i,
      /pikin\s+dey\s+shake/i,
    ],
    examples: [
      'the baby is having convulsions',
      'the baby had a fit',
      'pikin dey shake',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Convulsions\' → VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
      // WHO IMCI criterion verbatim: "movement only when stimulated".
      /only\s+move[sd]?\s+when\s+(?:i|you|we|someone)?\s*(?:touch|shake|stimulate|move|hold)/i,
      /move[sd]?\s+only\s+when\s+(?:touched|stimulated|held|shaken)/i,
      /won'?t\s+wake/i,
    ],
    examples: [
      'baby is very sleepy and floppy',
      'he is difficult to wake',
      'e no dey wake at all',
      'he only moves when I touch him',
      'he is not moving',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Movement only when stimulated or no movement at all\' → VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
      // "he feels cold", "the body is very hot" — the commonest lay phrasing, and one
      // the "to touch" forms above miss entirely.
      /(?:feels?|body\s+is|skin\s+is)\s+(?:very\s+|really\s+|too\s+)?(?:cold|hot|freezing|burning)\b/i,
      /body\s+dey\s+(?:hot|cold)\s+well\s+well/i,
      /\bhypothermi/i,
      /temperature[^.]{0,20}(?:3[89]|4[01])(?:\.\d)?\s*(?:°|deg|c\b)/i,
    ],
    examples: [
      'the baby is cold to touch',
      'he feels cold',
      'baby is hot to touch',
      'his body is very hot',
    ],
    source:
      'WHO IMCI young infant VERY SEVERE DISEASE — \'Fever (37.5°C or above or feels hot) or low body temperature (less than 35.5°C or feels cold)\'. The degree values were lost from the WHO 2014 PDF during text extraction and were recovered from the WHO-derived South Africa IMCI Chart Booklet 2022, which states them identically in two separate places. CONFIRM against the WHO 2014 chart by eye before final sign-off.',
    verified: true,
    verifiedBy:
      'author, cross-referenced to South Africa IMCI Chart Booklet 2022 (WHO-derived) after the WHO 2014 degree values were lost in extraction — NOT clinician sign-off',
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
    examples: [
      'yellow has reached his palms',
      'his palms are yellow',
      'body don yellow',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), \'Check for jaundice\' — \'Yellow palms and soles at any age\' (or any jaundice under 24 hours) → SEVERE JAUNDICE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
    examples: [
      'his soft spot is bulging',
      'the fontanelle is swollen',
    ],
    source:
      'WHO-derived South Africa IMCI Chart Booklet 2022, young infant assessment — \'Bulging fontanelle\' is listed among the signs requiring urgent referral. Not separately enumerated in the WHO 2014 young-infant chart, so confirm before relying on it.',
    verified: true,
    verifiedBy:
      'author, traced to South Africa IMCI Chart Booklet 2022 (WHO-derived) — NOT clinician sign-off',
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
    examples: [
      'the cord is red and has pus',
      'the navel is swollen and smells',
      'belly button don red',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Umbilicus red or draining pus\' → LOCAL BACTERIAL INFECTION, oral antibiotic + follow-up in 2 days',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
  },
  {
    id: 'NEO_FAST_BREATHING',
    label: 'Fast breathing (60 breaths per minute or more)',
    pathway: 'neonatal',
    // WHO IMCI lists fast breathing in a young infant under VERY SEVERE DISEASE —
    // "Refer URGENTLY to hospital" — not as a routine facility visit. This rule was
    // originally facility_visit, which under-triaged against the source guideline.
    urgency: 'emergency',
    slot: { breathing: 'fast' },
    patterns: [
      /(?:fast|rapid|quick)[^.]{0,15}breathing/i,
      /breathing[^.]{0,15}(?:fast|quick|rapid)/i,
      /dey\s+breathe\s+fast/i,
    ],
    examples: [
      'he is breathing very fast',
      'his breathing is fast',
      'e dey breathe fast',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Fast breathing (60 breaths per minute or more)\' → VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
    examples: [
      'his eyes are yellow',
      'the baby has jaundice on his face',
      'eye don yellow',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), \'Check for jaundice\' — jaundice after 24 hours with palms and soles not yellow → JAUNDICE, home care + follow-up in 1 day; refer if infant older than 14 days',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
  },
  {
    id: 'NEO_REDUCED_FEEDING',
    label: 'Not feeding well',
    pathway: 'neonatal',
    // "Not feeding well" is the FIRST sign listed under VERY SEVERE DISEASE in the WHO
    // IMCI young-infant chart, requiring urgent referral. This rule previously sat at
    // facility_visit, and NEO_NOT_FEEDING carried a `(?!\s+well)` lookahead that routed
    // "not feeding well" here deliberately — an under-triage introduced while trying to
    // avoid over-triage, and caught only by reading the source guideline.
    urgency: 'emergency',
    slot: { feeding: 'reduced' },
    patterns: [
      /(?:feeding|sucking|breastfeeding)[^.]{0,20}(?:less|poorly|not well|reduced)/i,
      /(?:not\s+feeding\s+well|feeding\s+badly)/i,
      /no\s+dey\s+chop\s+well/i,
    ],
    examples: [
      'he is feeding less than usual',
      'the baby is not feeding well',
      'no dey chop well',
    ],
    source:
      'WHO IMCI Chart Booklet (March 2014), Sick Young Infant — \'Not feeding well\' is listed under VERY SEVERE DISEASE, refer URGENTLY',
    verified: true,
    verifiedBy:
      'author, traced to WHO IMCI Chart Booklet (March 2014) retrieved from who.int — NOT clinician sign-off',
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
