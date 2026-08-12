import {
  MATERNAL_DOMAINS,
  NEONATAL_DOMAINS,
  domainById,
  domainsFor,
  isAssessmentComplete,
  nextDomain,
  progress,
  remainingDomains,
} from '../../../src/orchestrator/pathways';
import type { Slots } from '../../../src/types';

describe('pathway definitions', () => {
  it('covers the five neonatal domains from Chapter 3', () => {
    expect(NEONATAL_DOMAINS.map((d) => d.id)).toEqual([
      'feeding',
      'breathing',
      'activity',
      'temperature',
      'jaundice',
    ]);
  });

  it('covers the five maternal domains from Chapter 3', () => {
    expect(MATERNAL_DOMAINS.map((d) => d.id)).toEqual([
      'bleeding',
      'preeclampsia',
      'fever',
      'wound',
      'breast',
    ]);
  });

  it('asks the highest-risk domains first', () => {
    // A mother who abandons halfway has still been asked what matters most.
    expect(NEONATAL_DOMAINS[0]?.id).toBe('feeding');
    expect(MATERNAL_DOMAINS[0]?.id).toBe('bleeding');
  });

  it('gives every domain a fallback question in both languages', () => {
    for (const domain of [...NEONATAL_DOMAINS, ...MATERNAL_DOMAINS]) {
      expect(domain.fallbackQuestion.en.length).toBeGreaterThan(10);
      expect(domain.fallbackQuestion.pcm.length).toBeGreaterThan(10);
      expect(domain.fallbackQuestion.en).not.toBe(domain.fallbackQuestion.pcm);
    }
  });

  it('maps each domain to a distinct slot', () => {
    for (const domains of [NEONATAL_DOMAINS, MATERNAL_DOMAINS]) {
      const slots = domains.map((d) => d.slot);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });

  it('returns no domains before a pathway is chosen', () => {
    expect(domainsFor('unset')).toEqual([]);
  });

  it('looks a domain up by ID within its pathway', () => {
    expect(domainById('neonatal', 'feeding')?.label).toBe('Feeding');
    expect(domainById('neonatal', 'bleeding')).toBeUndefined();
    expect(domainById('maternal', 'bleeding')?.label).toBe('Bleeding');
  });
});

describe('sequencing', () => {
  it('starts with the first domain when nothing is known', () => {
    expect(nextDomain('neonatal', {})?.id).toBe('feeding');
  });

  it('skips domains the mother has already answered', () => {
    // She volunteered feeding and breathing in one message; do not re-ask.
    const slots: Slots = { feeding: 'normal', breathing: 'normal' };
    expect(nextDomain('neonatal', slots)?.id).toBe('activity');
  });

  it('skips a domain answered out of order', () => {
    expect(nextDomain('neonatal', { jaundice: 'none' })?.id).toBe('feeding');
    expect(remainingDomains('neonatal', { jaundice: 'none' }).map((d) => d.id)).not.toContain(
      'jaundice',
    );
  });

  it('returns null once every domain is filled', () => {
    const slots: Slots = {
      feeding: 'normal',
      breathing: 'normal',
      activity: 'alert',
      temperature: 'normal',
      jaundice: 'none',
    };
    expect(nextDomain('neonatal', slots)).toBeNull();
    expect(isAssessmentComplete('neonatal', slots)).toBe(true);
  });

  it('is not complete while any domain is outstanding', () => {
    expect(isAssessmentComplete('neonatal', { feeding: 'normal' })).toBe(false);
  });

  it('is never complete before a pathway is chosen', () => {
    expect(isAssessmentComplete('unset', {})).toBe(false);
    expect(nextDomain('unset', {})).toBeNull();
  });

  it('ignores slots belonging to the other pathway', () => {
    // Maternal slots must not count towards neonatal completeness.
    expect(nextDomain('neonatal', { bleeding: 'heavy' })?.id).toBe('feeding');
    expect(isAssessmentComplete('neonatal', { bleeding: 'heavy' })).toBe(false);
  });
});

describe('progress', () => {
  it('reports nothing answered at the start', () => {
    expect(progress('neonatal', {})).toEqual({ answered: 0, total: 5 });
  });

  it('counts answered domains', () => {
    expect(progress('neonatal', { feeding: 'normal', jaundice: 'none' })).toEqual({
      answered: 2,
      total: 5,
    });
  });

  it('reports completion', () => {
    const slots: Slots = {
      bleeding: 'normal_lochia',
      preeclampsia: 'none',
      fever: 'none',
      wound: 'healing',
      breast: 'normal',
    };
    expect(progress('maternal', slots)).toEqual({ answered: 5, total: 5 });
  });
});
