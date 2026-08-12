# Red-flag register — clinical review and sign-off

> Generated from the live register by `npm run docs:register`. Do not edit by hand — edits here will be overwritten, and the signed document must match the code that runs.

## What you are being asked to do

This system runs a set of deterministic rules **before and independently of** the language model. If a rule below matches what a mother writes, the system assigns the stated urgency and issues that advice — regardless of what the model concludes. These rules are the safety floor.

For each rule, please confirm or correct three things:

1. **Urgency** — is the assigned tier clinically right for this presentation?
2. **Source** — which section of WHO IMCI or the FMOH BEmONC protocol does this derive from? Each entry currently carries a `VERIFY:` marker and a best guess.
3. **Phrasings** — do the example phrasings genuinely describe the danger sign, and is anything important missing? Missing phrasings are the main way a system like this misses an emergency.

Record your decision in the sign-off block under each rule. Where you disagree, please say what the tier should be and why — the disagreement is as useful as the agreement.

## Status

- Rules in register: **20**
- Signed off: **9**
- Awaiting review: **11**

> ⚠️ While any rule is unverified the evaluation runner refuses to produce reportable results (`assertRegisterVerified()`), and generated reports are stamped NOT REPORTABLE. This is deliberate.

## Summary

| ID | Danger sign | Applies to | Assigned urgency | Reviewed |
|---|---|---|---|---|
| `MAT_CONVULSION` | Convulsion / fits (possible eclampsia) | Postpartum mother | emergency | ⬜ |
| `MAT_HAEMORRHAGE` | Heavy postpartum bleeding | Postpartum mother | emergency | ⬜ |
| `MAT_SEVERE_FEVER` | High fever with chills (possible puerperal sepsis) | Postpartum mother | emergency | ⬜ |
| `MAT_PREECLAMPSIA_SEVERE` | Severe pre-eclampsia warning signs | Postpartum mother | emergency | ⬜ |
| `MAT_COLLAPSE` | Loss of consciousness or collapse | Postpartum mother | emergency | ⬜ |
| `MAT_BREATHING` | Difficulty breathing | Postpartum mother | emergency | ⬜ |
| `MAT_WOUND_INFECTION` | Wound or perineal infection signs | Postpartum mother | facility_visit | ⬜ |
| `MAT_FOUL_LOCHIA` | Foul-smelling vaginal discharge | Postpartum mother | facility_visit | ⬜ |
| `MAT_MASTITIS` | Breast infection signs | Postpartum mother | facility_visit | ⬜ |
| `NEO_NOT_FEEDING` | Not feeding / unable to suck | Newborn / young infant | emergency | ✅ |
| `NEO_BREATHING_SEVERE` | Severe respiratory distress / apnoea | Newborn / young infant | emergency | ✅ |
| `NEO_CONVULSION` | Neonatal convulsion | Newborn / young infant | emergency | ✅ |
| `NEO_LETHARGY` | Lethargic or unresponsive | Newborn / young infant | emergency | ✅ |
| `NEO_TEMP_EXTREME` | Fever or hypothermia in a young infant | Newborn / young infant | emergency | ⬜ |
| `NEO_JAUNDICE_SEVERE` | Jaundice extending to palms or soles | Newborn / young infant | emergency | ✅ |
| `NEO_BULGING_FONTANELLE` | Bulging fontanelle | Newborn / young infant | emergency | ⬜ |
| `NEO_CORD_INFECTION` | Umbilical cord infection signs | Newborn / young infant | facility_visit | ✅ |
| `NEO_FAST_BREATHING` | Fast breathing (60 breaths per minute or more) | Newborn / young infant | emergency | ✅ |
| `NEO_JAUNDICE_FACE` | Jaundice of face or eyes | Newborn / young infant | facility_visit | ✅ |
| `NEO_REDUCED_FEEDING` | Not feeding well | Newborn / young infant | emergency | ✅ |

---

# Postpartum mother

## `MAT_CONVULSION` — Convulsion / fits (possible eclampsia)

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — eclampsia / convulsions in pregnancy and postpartum

**Phrasings this rule catches:**

- "she is having convulsions"
- "I had a fit this morning"
- "her body dey shake"
- "my wife started fitting"

**Also fires when** the assessment records `preeclampsia` = `convulsion` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_HAEMORRHAGE` — Heavy postpartum bleeding

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — primary postpartum haemorrhage

**Phrasings this rule catches:**

- "I am soaking a pad every hour"
- "bleeding too much since morning"
- "blood dey rush comot"
- "blood just dey rush comot plenty"
- "the bleeding is heavy"

**Also fires when** the assessment records `bleeding` = `soaking_pad_hourly` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_SEVERE_FEVER` — High fever with chills (possible puerperal sepsis)

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — puerperal sepsis danger signs

**Phrasings this rule catches:**

- "fever with chills and shivering"
- "I have a high fever"
- "body dey hot and cold dey catch me"

**Also fires when** the assessment records `fever` = `high_with_chills` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_PREECLAMPSIA_SEVERE` — Severe pre-eclampsia warning signs

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — severe pre-eclampsia warning signs

**Phrasings this rule catches:**

- "I have a severe headache"
- "my vision is blurred"
- "pain in my upper stomach"
- "my face is swollen"

**Also fires when** the assessment records `preeclampsia` = `severe_epigastric_or_swelling` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_COLLAPSE` — Loss of consciousness or collapse

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — shock / loss of consciousness

**Phrasings this rule catches:**

- "she is unconscious"
- "she fainted this morning"
- "she no dey answer"

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_BREATHING` — Difficulty breathing

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: FMOH BEmONC — respiratory distress

**Phrasings this rule catches:**

- "I am having difficulty breathing"
- "I can't breathe properly"
- "breath dey hard"

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_WOUND_INFECTION` — Wound or perineal infection signs

**Assigned urgency:** FACILITY VISIT — seen within 24 hours

**Proposed source:** VERIFY: FMOH BEmONC — wound infection

**Phrasings this rule catches:**

- "my stitches have pus and a bad smell"
- "the caesarean wound is red and swollen"
- "wound dey smell"

**Also fires when** the assessment records `wound` = `discharge_or_foul_odour` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `facility_visit` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_FOUL_LOCHIA` — Foul-smelling vaginal discharge

**Assigned urgency:** FACILITY VISIT — seen within 24 hours

**Proposed source:** VERIFY: FMOH BEmONC — endometritis

**Phrasings this rule catches:**

- "the discharge has a bad smell"
- "smelly discharge since yesterday"

| Reviewer question | Response |
|---|---|
| Is `facility_visit` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `MAT_MASTITIS` — Breast infection signs

**Assigned urgency:** FACILITY VISIT — seen within 24 hours

**Proposed source:** VERIFY: FMOH BEmONC — mastitis / breast abscess

**Phrasings this rule catches:**

- "my breast is red and hot with a hard lump"
- "breast dey pain and hot"
- "I think I have mastitis"

**Also fires when** the assessment records `breast` = `red_hot_painful_lump` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `facility_visit` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

---

# Newborn / young infant

## `NEO_NOT_FEEDING` — Not feeding / unable to suck

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant Age Up To 2 Months, 'Check for very severe disease and local bacterial infection' — 'Not feeding well' → VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "the baby is not feeding"
- "he has not fed at all today"
- "he has not been sucking since morning"
- "pikin no dey chop"
- "pikin no gree chop"
- "he refuses the breast"

**Also fires when** the assessment records `feeding` = `unable_to_feed` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_BREATHING_SEVERE` — Severe respiratory distress / apnoea

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Severe chest indrawing' → VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "the baby stopped breathing"
- "his lips are blue"
- "there is chest indrawing"
- "he is grunting"

**Also fires when** the assessment records `breathing` = `grunting_or_apnoea` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_CONVULSION` — Neonatal convulsion

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Convulsions' → VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "the baby is having convulsions"
- "the baby had a fit"
- "pikin dey shake"

**Also fires when** the assessment records `neonatal_convulsions` = `yes` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_LETHARGY` — Lethargic or unresponsive

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Movement only when stimulated or no movement at all' → VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "baby is very sleepy and floppy"
- "he is difficult to wake"
- "e no dey wake at all"
- "he only moves when I touch him"
- "he is not moving"

**Also fires when** the assessment records `activity` = `lethargic_or_unresponsive` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_TEMP_EXTREME` — Fever or hypothermia in a young infant

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Fever' / 'Low body temperature' → VERY SEVERE DISEASE. THRESHOLDS NOT YET CONFIRMED: the degree values were lost in PDF text extraction and must be read from the source chart

**Phrasings this rule catches:**

- "the baby is cold to touch"
- "he feels cold"
- "baby is hot to touch"
- "his body is very hot"

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_JAUNDICE_SEVERE` — Jaundice extending to palms or soles

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), 'Check for jaundice' — 'Yellow palms and soles at any age' (or any jaundice under 24 hours) → SEVERE JAUNDICE, refer URGENTLY

**Phrasings this rule catches:**

- "yellow has reached his palms"
- "his palms are yellow"
- "body don yellow"

**Also fires when** the assessment records `jaundice` = `to_palms_soles` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_BULGING_FONTANELLE` — Bulging fontanelle

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** VERIFY: WHO IMCI — bulging fontanelle (possible meningitis)

**Phrasings this rule catches:**

- "his soft spot is bulging"
- "the fontanelle is swollen"

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_CORD_INFECTION` — Umbilical cord infection signs

**Assigned urgency:** FACILITY VISIT — seen within 24 hours

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Umbilicus red or draining pus' → LOCAL BACTERIAL INFECTION, oral antibiotic + follow-up in 2 days

**Phrasings this rule catches:**

- "the cord is red and has pus"
- "the navel is swollen and smells"
- "belly button don red"

**Also fires when** the assessment records `cord_appearance` = `red_or_discharging` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `facility_visit` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_FAST_BREATHING` — Fast breathing (60 breaths per minute or more)

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Fast breathing (60 breaths per minute or more)' → VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "he is breathing very fast"
- "his breathing is fast"
- "e dey breathe fast"

**Also fires when** the assessment records `breathing` = `fast` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_JAUNDICE_FACE` — Jaundice of face or eyes

**Assigned urgency:** FACILITY VISIT — seen within 24 hours

**Proposed source:** WHO IMCI Chart Booklet (March 2014), 'Check for jaundice' — jaundice after 24 hours with palms and soles not yellow → JAUNDICE, home care + follow-up in 1 day; refer if infant older than 14 days

**Phrasings this rule catches:**

- "his eyes are yellow"
- "the baby has jaundice on his face"
- "eye don yellow"

**Also fires when** the assessment records `jaundice` = `face_only` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `facility_visit` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

## `NEO_REDUCED_FEEDING` — Not feeding well

**Assigned urgency:** EMERGENCY — refer immediately

**Proposed source:** WHO IMCI Chart Booklet (March 2014), Sick Young Infant — 'Not feeding well' is listed under VERY SEVERE DISEASE, refer URGENTLY

**Phrasings this rule catches:**

- "he is feeding less than usual"
- "the baby is not feeding well"
- "no dey chop well"

**Also fires when** the assessment records `feeding` = `reduced` — that is, when the model has understood the mother to mean this even if she used different words.

| Reviewer question | Response |
|---|---|
| Is `emergency` the correct urgency? | ☐ Yes ☐ No — should be: ________ |
| Correct guideline section | ________________________________ |
| Missing phrasings to add | ________________________________ |
| Phrasings that should NOT fire this | ________________________________ |
| Reviewer name / date | ________________________________ |

---

## After review

For each rule the reviewer has approved, the developer updates `src/safety/redFlags.ts`:

```ts
source: 'WHO IMCI 2014, Chart 2 — Check for very severe disease',  // no VERIFY marker
verified: true,
```

Once every rule is verified, `assertRegisterVerified()` stops throwing and the evaluation harness will produce reportable results. This generated document, with the completed sign-off blocks, becomes an appendix in the dissertation.
