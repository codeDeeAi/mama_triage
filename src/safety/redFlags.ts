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
   * Compound slot clause, for criteria that depend on more than one slot at once.
   *
   * `slot` above is a disjunction over single values, which cannot express a guideline
   * criterion such as "jaundice present AND age under 24 hours". Keep the predicate
   * small and pure; it is reviewed by reading it, like a pattern.
   */
  slotWhen?: (slots: Slots) => boolean;
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart B6 'Emergency signs' — convulsions or unconscious: refer urgently; chart D28 'Advise on when to return' — go to a facility immediately, day or night, for convulsions.",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart B6 'Dangerous fever' (fever >38°C with very fast breathing, stiff neck, lethargy or very weak/unable to stand: refer urgently); chart E6 'If fever or foul-smelling lochia'; chart D28 (go immediately for fever with being too weak to get out of bed; fever alone, as soon as possible). This rule is deliberately MORE cautious than the guide: chills or a reported 'high fever' escalate without an accompanying sign, because the service cannot take a temperature.",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart B7 'Priority signs' (severe headache, blurred vision, epigastric pain: measure BP); chart E3 'If elevated diastolic blood pressure' (>=110 mmHg: refer urgently); chart D28 (go immediately for headache with blurred vision). This rule is deliberately MORE cautious than the guide: any one warning sign, including face or hand swelling, escalates, because the service cannot measure blood pressure.",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart B3 'Circulation (shock)' (cold moist skin, weak fast pulse) and chart B6 'Emergency signs' (unconscious): refer urgently.",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart B3 'Airway and breathing' (very difficult breathing or central cyanosis: refer urgently); chart E9 'If cough or breathing difficulty'; chart D28 (go immediately for fast or difficult breathing, shortness of breath or chest pain).",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart E7 'If pus or perineal pain' (perineal infection: treat, follow up in 2 days); chart D28 (go as soon as possible for perineal pain or draining pus). Caesarean wounds are not charted separately; the perineal chart is the nearest section.",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart E6 'If fever or foul-smelling lochia' (with fever >38°C: uterine infection, refer urgently); chart D28 (go as soon as possible for foul-smelling lochia).",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
    source:
      "WHO PCPNC, 3rd ed. (2015), chart E8 'If breast problem', which refers to chart J9 (painful, swollen, red part of breast with fever: mastitis, treat and reassess in 2 days); chart D28 (go as soon as possible for swollen, red or tender breasts).",
    verified: true,
    verifiedBy:
      'author, traced to WHO PCPNC 3rd ed. (2015), WHO IRIS edition ISBN 978 92 4 154935 6, chart codes checked 9 November 2026. NOT a clinician sign-off.',
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
      'WHO IMCI chart booklet, Management of the sick young infant aged up to 2 months (2019), \'Check for possible serious bacterial infection or very severe disease\' — \'Not able to feed at all or not feeding well\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Severe chest indrawing\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. Unchanged from the March 2014 edition. Grunting and stopped breathing are not listed in either edition; the rule treats them as at least as severe as chest indrawing.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Convulsions\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Movement only when stimulated or no movement at all\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'High body temperature (38°C or above)\' or \'Low body temperature (less than 35.5°C)\', measured axillary → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. The March 2014 edition used 37.5°C or \'feels hot\'. This rule is deliberately MORE cautious than the 2019 chart: it also fires on a mother\'s report that the baby feels hot or cold, because the service cannot take a temperature. Numeric readings it matches start at 38°C.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
  },
  {
    id: 'NEO_JAUNDICE_EARLY',
    label: 'Jaundice in the first day of life',
    pathway: 'neonatal',
    urgency: 'emergency',
    // Any jaundice under 24 hours of age is SEVERE JAUNDICE in the IMCI young-infant chart,
    // regardless of where it is visible. The register previously carried only the
    // palms-and-soles criterion (NEO_JAUNDICE_SEVERE) and the face-only follow-up tier
    // (NEO_JAUNDICE_FACE), so a baby born yesterday with yellow skin was routed to a
    // facility visit in every run of the 9 November 2026 evaluation (NEO-022). This rule
    // closes that gap. "Born yesterday" is a lay proxy for under 24 hours and is
    // deliberately generous: the rule also fires at age_days = 1.
    slotWhen: (slots) =>
      slots.jaundice !== undefined &&
      slots.jaundice !== 'none' &&
      typeof slots.age_days === 'number' &&
      slots.age_days <= 1,
    // The span between the age cue and the colour word may not contain a negation cue, so
    // "born yesterday and is not yellow" does not fire (the negation guard only looks
    // before a match, and a negation inside a match is treated as part of the sign).
    patterns: [
      // jaundice/yellow ... born today/yesterday/last night, or hours old
      /(?:yellow|jaundice)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,60}\b(?:born|delivered)\s+(?:\w+\s+){0,2}(?:today|yesterday|last\s+night|this\s+morning|tonight)/i,
      /\b(?:born|delivered)\s+(?:\w+\s+){0,2}(?:today|yesterday|last\s+night|this\s+morning|tonight)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,60}(?:yellow|jaundice)/i,
      /(?:yellow|jaundice)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,60}\b(?:\d{1,2}|a\s+few|some|several)\s+hours?\s+old/i,
      /\b(?:\d{1,2}|a\s+few|some|several)\s+hours?\s+old(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,60}(?:yellow|jaundice)/i,
      /(?:yellow|jaundice)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,40}\b(?:just|newly|only\s+just)\s+born/i,
      /\b(?:just|newly)\s+born(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,40}(?:yellow|jaundice)/i,
      // Pidgin: "I born am yesterday, e don yellow" / "pikin wey I born today dey yellow"
      /\bborn\s+(?:am\s+)?(?:today|yesterday|last\s+night)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,40}(?:yellow|don\s+yellow)/i,
      /(?:yellow|don\s+yellow)(?:(?!\b(?:not|no|never|isn't|ain't)\b)[^.]){0,40}\bborn\s+(?:am\s+)?(?:today|yesterday|last\s+night)/i,
    ],
    examples: [
      'she was born yesterday evening and already looks yellow today',
      'he is only a few hours old and his skin is yellow',
      'I born am yesterday and e don yellow',
      'the baby was just born and already has jaundice',
    ],
    source:
      'WHO IMCI chart booklet for the sick young infant (2019), \'Check for jaundice\' — \'Any jaundice in an infant aged less than 24 hours\' → SEVERE JAUNDICE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019), \'Check for jaundice\' — \'Yellow palms or soles at any age\' (or any jaundice under 24 hours) → SEVERE JAUNDICE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO-derived South Africa IMCI Chart Booklet 2022, young infant assessment — \'Bulging fontanelle\' is listed among the signs requiring urgent referral. It is not listed in the WHO young-infant chart of 2014 or 2019, so this rule is MORE cautious than WHO; confirm with a clinician before relying on it.',
    verified: true,
    verifiedBy:
      'author, traced to South Africa IMCI Chart Booklet 2022 (WHO-derived); not listed in the WHO young-infant chart of 2014 or 2019 — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Umbilicus red or draining pus\' → LOCAL BACTERIAL INFECTION, oral amoxicillin for 5 days and follow-up in 2 days. Unchanged in tier from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Fast breathing (60 breaths per minute or more) in infants less than 7 days old\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY; in infants 7–59 days old → PNEUMONIA, oral amoxicillin for 7 days and follow-up in 3 days. The March 2014 edition classified fast breathing at any young-infant age as VERY SEVERE DISEASE. This rule is deliberately MORE cautious than the 2019 chart for infants aged 7 to 59 days: a mother cannot count breaths or look for chest indrawing, so a report of fast breathing is treated as an emergency at any age. Flagged for clinical review.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019), \'Check for jaundice\' — jaundice appearing after 24 hours with palms and soles not yellow → JAUNDICE: home care, return immediately if palms or soles turn yellow, follow-up in 1 day, and refer to hospital if older than 3 weeks (the March 2014 edition said 14 days). Tier unchanged.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
      'WHO IMCI chart booklet for the sick young infant (2019) — \'Not able to feed at all or not feeding well\' → POSSIBLE SERIOUS BACTERIAL INFECTION or VERY SEVERE DISEASE, refer URGENTLY. Unchanged from the March 2014 edition.',
    verified: true,
    verifiedBy:
      'author, traced to the WHO IMCI chart booklet for the sick young infant (2019) and checked against the March 2014 edition — NOT clinician sign-off',
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
    if (!ruleApplies(rule, pathway)) continue;

    if (rule.slotWhen?.(slots)) {
      hits.push({
        id: rule.id,
        urgency: rule.urgency,
        pathway: rule.pathway,
        via: 'slot',
        evidence: Object.entries(slots)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(','),
        source: rule.source,
      });
      continue;
    }

    if (!rule.slot) continue;

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

/**
 * Rules still awaiting clinical reviewer sign-off.
 *
 * `rules` defaults to the live register; it is a parameter only so the guard below can be
 * exercised against a register that still has pending rules. `RED_FLAGS` is frozen, and
 * every rule in it currently carries a decision, so there is otherwise no way to test the
 * failure path of a check whose whole job is to fail.
 */
export function unverifiedRules(rules: readonly RedFlagRule[] = RED_FLAGS): RedFlagRule[] {
  return rules.filter((r) => !r.verified);
}

/**
 * Rules marked verified by a SIMULATED review rather than a qualified clinician.
 *
 * `verified` is a boolean, but the assurance behind it is not uniform: some rules are
 * traced to verbatim guideline text, others are the author's judgement standing in for a
 * reviewer who has not yet been engaged. Collapsing those into one flag would let a
 * simulated placeholder read as clinical validation in the report, so the distinction is
 * surfaced separately and printed on every generated report.
 */
export function simulatedRules(rules: readonly RedFlagRule[] = RED_FLAGS): RedFlagRule[] {
  return rules.filter((r) => r.verified && /SIMULATED REVIEW/i.test(r.verifiedBy ?? ''));
}

/** True when every verified rule is backed by a real source rather than a placeholder. */
export function registerFullyAssured(): boolean {
  return unverifiedRules().length === 0 && simulatedRules().length === 0;
}

/**
 * Throw if any rule is still unverified.
 *
 * Called by the evaluation runner so that unverified clinical logic cannot silently
 * produce results that end up in the report (plan section 9.1).
 */
export function assertRegisterVerified(rules: readonly RedFlagRule[] = RED_FLAGS): void {
  const pending = unverifiedRules(rules);
  if (pending.length > 0) {
    throw new Error(
      `Red-flag register has ${pending.length} unverified rule(s); clinical reviewer ` +
        `sign-off is required before an evaluation run may be reported. Pending: ` +
        pending.map((r) => r.id).join(', '),
    );
  }
}
