import {
  buildFallback,
  dangerSigns,
  disclaimer,
  referralDirective,
  type FallbackReason,
} from '../../../src/safety/fallback';
import type { Language, Pathway } from '../../../src/types';

const LANGUAGES: Language[] = ['en', 'pcm'];
const PATHWAYS: Pathway[] = ['maternal', 'neonatal', 'unset'];
const REASONS: FallbackReason[] = [
  'llm_unavailable',
  'llm_timeout',
  'llm_invalid_output',
  'circuit_open',
  'retrieval_failed',
];

describe('buildFallback', () => {
  it('never returns an empty message', () => {
    for (const pathway of PATHWAYS) {
      for (const language of LANGUAGES) {
        const msg = buildFallback(pathway, language, 'llm_unavailable');
        expect(msg.body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('always ends the session rather than continuing to assess', () => {
    for (const reason of REASONS) {
      expect(buildFallback('maternal', 'en', reason).terminatesSession).toBe(true);
    }
  });

  it('preserves the reason for the audit log', () => {
    for (const reason of REASONS) {
      expect(buildFallback('maternal', 'en', reason).reason).toBe(reason);
    }
  });

  it('always tells the mother to go to a facility if any sign applies', () => {
    for (const pathway of PATHWAYS) {
      const en = buildFallback(pathway, 'en', 'llm_timeout').body;
      expect(en).toMatch(/health facility/i);
      const pcm = buildFallback(pathway, 'pcm', 'llm_timeout').body;
      expect(pcm).toMatch(/health centre/i);
    }
  });

  it('always carries the standing disclaimer', () => {
    for (const pathway of PATHWAYS) {
      for (const language of LANGUAGES) {
        expect(buildFallback(pathway, language, 'circuit_open').body).toContain(
          disclaimer(language),
        );
      }
    }
  });

  it('shows only maternal signs on the maternal pathway', () => {
    const body = buildFallback('maternal', 'en', 'llm_unavailable').body;
    expect(body).toMatch(/soaking more than one pad/i);
    expect(body).not.toMatch(/unable to suck at the breast/i);
  });

  it('shows only neonatal signs on the neonatal pathway', () => {
    const body = buildFallback('neonatal', 'en', 'llm_unavailable').body;
    expect(body).toMatch(/unable to suck at the breast/i);
    expect(body).not.toMatch(/soaking more than one pad/i);
  });

  it('shows both lists, labelled, when the pathway is unknown', () => {
    const body = buildFallback('unset', 'en', 'llm_unavailable').body;
    expect(body).toMatch(/For the mother/i);
    expect(body).toMatch(/For the baby/i);
    expect(body).toMatch(/soaking more than one pad/i);
    expect(body).toMatch(/unable to suck at the breast/i);
  });

  it('labels both lists in Pidgin too', () => {
    const body = buildFallback('unset', 'pcm', 'llm_unavailable').body;
    expect(body).toMatch(/For mama/i);
    expect(body).toMatch(/For di pikin/i);
  });

  it('does not label the list when the pathway is known', () => {
    expect(buildFallback('maternal', 'en', 'llm_unavailable').body).not.toMatch(
      /For the mother/i,
    );
  });

  it('formats danger signs as bullets', () => {
    expect(buildFallback('neonatal', 'en', 'llm_unavailable').body).toContain('• ');
  });

  it('opens by admitting it cannot complete the assessment', () => {
    expect(buildFallback('maternal', 'en', 'llm_timeout').body).toMatch(
      /not able to complete/i,
    );
    expect(buildFallback('maternal', 'pcm', 'llm_timeout').body).toMatch(/no fit finish/i);
  });

  it('stays within a sensible WhatsApp message length', () => {
    for (const pathway of PATHWAYS) {
      for (const language of LANGUAGES) {
        const body = buildFallback(pathway, language, 'llm_unavailable').body;
        expect(body.length).toBeLessThan(4096); // hard Cloud API limit
      }
    }
  });
});

describe('referralDirective', () => {
  it('gives an unambiguous instruction in both languages', () => {
    expect(referralDirective('en')).toMatch(/now/i);
    expect(referralDirective('pcm')).toMatch(/now now/i);
  });

  it('covers the case where the mother cannot travel', () => {
    expect(referralDirective('en')).toMatch(/call someone/i);
    expect(referralDirective('pcm')).toMatch(/call person/i);
  });
});

describe('disclaimer', () => {
  it('states it is not a diagnosis in both languages', () => {
    expect(disclaimer('en')).toMatch(/not a diagnosis/i);
    expect(disclaimer('pcm')).toMatch(/no be doctor talk/i);
  });
});

describe('dangerSigns', () => {
  it('returns the maternal list', () => {
    const signs = dangerSigns('maternal', 'en');
    expect(signs.length).toBeGreaterThan(0);
    expect(signs.join(' ')).toMatch(/pad/i);
  });

  it('returns the neonatal list', () => {
    expect(dangerSigns('neonatal', 'en').join(' ')).toMatch(/suck/i);
  });

  it('returns both lists when the pathway is unknown', () => {
    const both = dangerSigns('unset', 'en');
    expect(both.length).toBe(
      dangerSigns('maternal', 'en').length + dangerSigns('neonatal', 'en').length,
    );
  });

  it('returns a copy, so callers cannot mutate the register', () => {
    const first = dangerSigns('maternal', 'en');
    first.push('injected');
    expect(dangerSigns('maternal', 'en')).not.toContain('injected');
  });

  it('provides a translation for every sign in both languages', () => {
    for (const pathway of PATHWAYS) {
      expect(dangerSigns(pathway, 'en').length).toBe(dangerSigns(pathway, 'pcm').length);
    }
  });
});
