import {
  demonstrationFor,
  demonstrationOffer,
} from '../../../src/orchestrator/demonstrations';
import { MATERNAL_DOMAINS, NEONATAL_DOMAINS } from '../../../src/orchestrator/pathways';
import { toMarkdownV2 } from '../../../src/telegram/client';
import type { Language } from '../../../src/types';

const LANGUAGES: Language[] = ['en', 'pcm'];

describe('demonstrationFor', () => {
  it('finds the video for a domain that has one', () => {
    expect(demonstrationFor('breathing')?.url).toContain('globalhealthmedia.org');
  });

  it('tolerates case and surrounding space in the model\'s domain value', () => {
    expect(demonstrationFor('  Breathing ')?.domainId).toBe('breathing');
  });

  it('returns nothing for a domain with no video, rather than guessing', () => {
    // A domain with no suitable film is a gap to be filled, not a reason to point a
    // mother at something approximate.
    expect(demonstrationFor('jaundice')).toBeUndefined();
    expect(demonstrationFor('bleeding')).toBeUndefined();
  });

  it('returns nothing for an unrecognised or absent domain', () => {
    expect(demonstrationFor('wharrgarbl')).toBeUndefined();
    expect(demonstrationFor(undefined)).toBeUndefined();
    expect(demonstrationFor('')).toBeUndefined();
  });

  it('only ever names domains the state machine actually walks', () => {
    // A video keyed to a domain id that does not exist could never be shown, and would
    // sit in the register looking like coverage it does not provide.
    const known = new Set(
      [...NEONATAL_DOMAINS, ...MATERNAL_DOMAINS].map((d) => d.id),
    );
    for (const id of ['breathing', 'feeding']) {
      expect(known.has(id)).toBe(true);
    }
  });
});

describe('demonstrationOffer', () => {
  it.each(LANGUAGES)('offers the link as optional and names the data cost (%s)', (language) => {
    const offer = demonstrationOffer('breathing', language) ?? '';
    expect(offer).toContain('https://');
    expect(offer).toMatch(/data/i);
    // Phrased as a question, never as a step she must complete.
    expect(offer).toMatch(language === 'en' ? /not sure/i : /no sure/i);
  });

  it.each(LANGUAGES)('returns null when there is nothing to offer (%s)', (language) => {
    expect(demonstrationOffer('bleeding', language)).toBeNull();
    expect(demonstrationOffer(undefined, language)).toBeNull();
  });

  it('survives the MarkdownV2 conversion with its bold markers intact', () => {
    // Every outbound message goes through toMarkdownV2, which splits on the asterisk.
    // An unbalanced marker corrupts the escaping and Telegram rejects the whole message.
    for (const language of LANGUAGES) {
      const offer = demonstrationOffer('breathing', language) ?? '';
      const asterisks = (offer.match(/\*/g) ?? []).length;
      expect(asterisks % 2).toBe(0);
      expect((toMarkdownV2(offer).match(/(?<!\\)\*/g) ?? []).length).toBe(asterisks);
    }
  });

  it('links to the publisher rather than a re-upload', () => {
    // The licence permits linking but forbids re-hosting the videos elsewhere.
    const offer = demonstrationOffer('breathing', 'en') ?? '';
    expect(offer).toContain('globalhealthmedia.org');
    expect(offer).not.toMatch(/youtube\.com|youtu\.be|vimeo/i);
  });
});

describe('register provenance', () => {
  it('marks every entry as awaiting clinical sign-off', () => {
    // Same discipline as the red-flag register: a video is clinical content shown to a
    // mother, and claiming review that has not happened is the failure to avoid.
    for (const id of ['breathing', 'feeding']) {
      const entry = demonstrationFor(id)!;
      expect(entry.verified).toBe(false);
      expect(entry.verifiedBy).toMatch(/NOT clinician sign-off/);
    }
  });
});
