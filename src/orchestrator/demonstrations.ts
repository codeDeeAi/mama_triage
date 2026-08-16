/**
 * Demonstration videos attached to assessment questions.
 *
 * Some danger signs cannot be described in words to someone who has never been taught to
 * look for them. "Is the chest pulling in?" is the clearest example: chest indrawing is
 * the single most useful sign of severe pneumonia in an infant, and a mother who has not
 * seen it will answer confidently and wrongly in either direction. A ten-second clip
 * answers that better than any phrasing the model can produce, so the value here is not
 * decoration — it is the accuracy of the slot her answer fills, which is what the whole
 * triage decision rests on.
 *
 * Three rules govern this file, and each exists because the obvious implementation would
 * be unsafe:
 *
 * **The model never supplies a URL.** It names a domain — a value from a closed list it
 * was already returning — and the link is looked up here. A model asked for a "helpful
 * video link" will invent plausible ones, and a fabricated URL shown to a frightened
 * mother is worse than no link at all. Nothing in this file can be reached by generation.
 *
 * **A link is evidence like any other claim.** These carry the same `verified` /
 * `verifiedBy` provenance as the red-flag register, and for the same reason: a video is
 * clinical content shown to a mother, and it needs the same sign-off as the wording of a
 * danger sign. Entries below are traced to source but NOT clinician-approved, and the
 * gaps are recorded as gaps rather than filled with something approximate.
 *
 * **Watching costs her money.** Data is a real barrier in the target setting, so a link
 * is offered as optional, never as an instruction, and never on an emergency turn — where
 * the only acceptable message is "go now", and anything competing with it is harm.
 *
 * Source: Global Health Media Project, whose newborn and breastfeeding series are made
 * for exactly this setting — low-bandwidth, filmed in comparable contexts, and free to
 * share with families under their licence. Note their terms: the videos may be linked to,
 * but may NOT be re-uploaded to another channel or platform, so these must stay as links
 * to the publisher rather than being mirrored.
 * https://globalhealthmedia.org/about-us/terms-of-use/
 */

import type { Language } from '../types';

export interface Demonstration {
  /** Matches `Domain.id` in pathways.ts. Domain ids are unique across both pathways. */
  domainId: string;
  /** Publisher's page for the video. Never a re-upload — see the licence note above. */
  url: string;
  /** What the mother will actually see, so the offer can say something true. */
  shows: string;
  publisher: string;
  /** False until a clinical reviewer has watched it and approved it for mothers. */
  verified: boolean;
  verifiedBy: string;
}

/**
 * The register.
 *
 * Deliberately short. Every entry is a URL that was checked to exist at the publisher;
 * domains with no suitable mother-facing video are absent rather than pointed at
 * something approximate. `demonstrationFor` returning undefined is a normal outcome and
 * the question is simply asked without a link.
 *
 * Known gaps, left open on purpose:
 *   - jaundice — the blanching test on palms and soles is the highest-value demonstration
 *     in the whole assessment and no standalone mother-facing video was found. Worth
 *     sourcing or commissioning.
 *   - all five maternal domains — the publisher's series is newborn- and
 *     breastfeeding-focused. Postpartum haemorrhage volume estimation, in particular,
 *     would need a different source.
 */
const REGISTER: readonly Demonstration[] = Object.freeze([
  {
    domainId: 'breathing',
    url: 'https://globalhealthmedia.org/video/breathing-problems/',
    shows: 'fast breathing, chest pulling in, and nostrils flaring in a newborn',
    publisher: 'Global Health Media Project',
    verified: false,
    verifiedBy:
      'author, traced to globalhealthmedia.org — NOT clinician sign-off, and not yet ' +
      'reviewed for whether a health-worker-facing film is appropriate for a mother',
  },
  {
    domainId: 'feeding',
    url: 'https://globalhealthmedia.org/our-projects/breastfeeding-series/',
    shows: 'how a baby attaches to the breast, and what a poor attachment looks like',
    publisher: 'Global Health Media Project',
    verified: false,
    verifiedBy:
      'author, traced to globalhealthmedia.org — NOT clinician sign-off. This is the ' +
      'series index rather than a single film; a specific video should replace it',
  },
]);

const BY_DOMAIN = new Map(REGISTER.map((d) => [d.domainId, d]));

/**
 * Find the demonstration for a domain, if there is one.
 *
 * The model's `next_action.domain` is free text within a length bound, so it is matched
 * leniently on case and surrounding space but never fuzzily: an unrecognised value yields
 * no link rather than a guess at which video was meant.
 */
export function demonstrationFor(domainId: string | undefined): Demonstration | undefined {
  if (!domainId) return undefined;
  return BY_DOMAIN.get(domainId.trim().toLowerCase());
}

const OFFER: Record<Language, (shows: string, url: string) => string> = {
  en: (shows, url) =>
    [
      `*Not sure?* This short video shows ${shows}:`,
      url,
      'Watching it uses data, and you can answer without it.',
    ].join('\n'),
  pcm: (shows, url) =>
    [
      `*You no sure?* Dis short video show ${shows}:`,
      url,
      'To watch am go use data, and you fit answer without am.',
    ].join('\n'),
};

/**
 * The optional offer appended to a question, or null when there is nothing to offer.
 *
 * Phrased as a question rather than an instruction, and it says plainly that watching
 * costs data. A mother who cannot spend it should not have to work that out, and should
 * not feel she has failed to follow an instruction by answering without it.
 */
export function demonstrationOffer(
  domainId: string | undefined,
  language: Language,
): string | null {
  const found = demonstrationFor(domainId);
  if (!found) return null;
  return OFFER[language](found.shows, found.url);
}
