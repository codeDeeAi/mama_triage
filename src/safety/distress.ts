/**
 * Distress-language detector.
 *
 * Chapter 3, section 3.4.3 requires that "any session containing distress language" is
 * escalated to an immediate emergency referral, irrespective of the triage pathway in
 * progress. This module implements that requirement.
 *
 * It is deliberately kept separate from the clinical red-flag register, because the two
 * concerns differ:
 *   - a red flag is a clinical sign requiring referral;
 *   - distress is a psychological or crisis signal requiring a different response, and in
 *     some cases a different referral destination (mental-health support rather than an
 *     obstetric emergency).
 *
 * The register below is conservative in the direction of over-detection. A false positive
 * costs an unnecessary "please go to a facility" message; a false negative may cost a
 * life. Every category is nonetheless reviewed for cultural appropriateness by the
 * clinical reviewers, since idiomatic Nigerian English and Pidgin expressions of worry
 * ("I don tire", "e don do me") do not always indicate crisis.
 */

export type DistressCategory =
  /** Self-harm or suicidal ideation from the mother. */
  | 'self_harm'
  /** Fear that the mother or baby is dying now. */
  | 'perceived_death_risk'
  /** Acute panic or being overwhelmed. */
  | 'acute_panic'
  /** Possible harm towards the infant. */
  | 'infant_harm';

export interface DistressRule {
  category: DistressCategory;
  patterns: RegExp[];
  /** Whether this category needs a mental-health referral in addition to clinical advice. */
  needsMentalHealthReferral: boolean;
}

const DISTRESS_RULES: readonly DistressRule[] = Object.freeze([
  {
    category: 'self_harm',
    needsMentalHealthReferral: true,
    patterns: [
      /kill\s+myself/i,
      /\bsuicid/i,
      /end\s+(?:my|this)\s+life/i,
      /(?:don'?t|do not)\s+want\s+to\s+live/i,
      /better\s+off\s+dead/i,
      /want\s+to\s+die/i,
      /harm\s+myself/i,
      /i\s+wan\s+die/i,
      /make\s+i\s+just\s+die/i,
    ],
  },
  {
    category: 'infant_harm',
    needsMentalHealthReferral: true,
    patterns: [
      /hurt\s+(?:my|the)\s+baby/i,
      /harm\s+(?:my|the)\s+baby/i,
      /(?:don'?t|do not)\s+want\s+(?:this|the|my)\s+baby/i,
      /throw\s+(?:the|my)\s+baby/i,
    ],
  },
  {
    category: 'perceived_death_risk',
    needsMentalHealthReferral: false,
    patterns: [
      /(?:she|he|baby|pikin|my\s+baby)\s+is\s+dying/i,
      /(?:i\s+think\s+)?(?:she|he|baby)\s+(?:will|going\s+to|go)\s+die/i,
      /\bdying\b/i,
      /\bnot\s+going\s+to\s+make\s+it\b/i,
      /e\s+wan\s+die/i,
      /pikin\s+dey\s+die/i,
      /save\s+(?:my|the)\s+baby/i,
    ],
  },
  {
    category: 'acute_panic',
    needsMentalHealthReferral: false,
    patterns: [
      /\bhelp\s+me\s+(?:please|now|god)/i,
      /(?:please\s+){2,}/i,
      /i\s+(?:don'?t|do\s+not)\s+know\s+what\s+to\s+do/i,
      /\bemergency\b/i,
      /\bi\s+am\s+scared\b/i,
      /i\s+dey\s+fear/i,
      /abeg\s+help/i,
    ],
  },
]);

export interface DistressDetection {
  detected: boolean;
  categories: DistressCategory[];
  /** The matched substrings, for the audit log. */
  evidence: string[];
  /** True when any matched category warrants a mental-health referral. */
  needsMentalHealthReferral: boolean;
}

/**
 * Scan a message for distress language.
 *
 * Note: unlike the clinical red-flag matcher, this does NOT apply negation suppression.
 * "I don't want to live" and "I do not want to live" must both fire, and the phrasings
 * that matter here embed their own negation. Attempting to strip negations in this
 * context would remove exactly the strings we care about.
 */
export function detectDistress(text: string): DistressDetection {
  const categories = new Set<DistressCategory>();
  const evidence: string[] = [];
  let needsMentalHealthReferral = false;

  if (text) {
    for (const rule of DISTRESS_RULES) {
      for (const pattern of rule.patterns) {
        const m = pattern.exec(text);
        if (m) {
          categories.add(rule.category);
          evidence.push(m[0]);
          if (rule.needsMentalHealthReferral) needsMentalHealthReferral = true;
          break;
        }
      }
    }
  }

  return {
    detected: categories.size > 0,
    categories: [...categories],
    evidence,
    needsMentalHealthReferral,
  };
}

/** Exposed for tests and for the reviewer-facing documentation of the register. */
export const DISTRESS_REGISTER: readonly DistressRule[] = DISTRESS_RULES;
