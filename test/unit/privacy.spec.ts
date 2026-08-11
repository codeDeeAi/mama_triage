import { hashPhone, hashesEqual, normalisePhone } from '../../src/privacy/hashPhone';
import { looksRedacted, redact, redactText } from '../../src/privacy/redact';

const PEPPER = 'a'.repeat(64);

describe('normalisePhone', () => {
  it('strips formatting so one mother maps to one hash', () => {
    const variants = [
      '2348012345678',
      '+2348012345678',
      '+234 801 234 5678',
      '+234-801-234-5678',
      '(234) 801 234 5678',
      '002348012345678',
    ];
    const normalised = variants.map(normalisePhone);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('2348012345678');
  });

  it('converts Nigerian local format to international', () => {
    expect(normalisePhone('08012345678')).toBe('2348012345678');
    expect(normalisePhone('0801 234 5678')).toBe('2348012345678');
  });

  it('leaves an already-canonical number untouched', () => {
    expect(normalisePhone('2348012345678')).toBe('2348012345678');
  });

  it('rejects input with no digits', () => {
    expect(() => normalisePhone('')).toThrow(/empty phone number/);
    expect(() => normalisePhone('not-a-number')).toThrow(/empty phone number/);
  });
});

describe('hashPhone', () => {
  it('produces a 64-character hex digest matching the CHAR(64) column', () => {
    const hash = hashPhone('2348012345678', PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, so session continuity works', () => {
    expect(hashPhone('2348012345678', PEPPER)).toBe(hashPhone('2348012345678', PEPPER));
  });

  it('maps every formatting variant of one number to the same hash', () => {
    const canonical = hashPhone('2348012345678', PEPPER);
    expect(hashPhone('+234 801 234 5678', PEPPER)).toBe(canonical);
    expect(hashPhone('08012345678', PEPPER)).toBe(canonical);
  });

  it('distinguishes different numbers', () => {
    expect(hashPhone('2348012345678', PEPPER)).not.toBe(hashPhone('2348012345679', PEPPER));
  });

  it('produces different hashes under different peppers', () => {
    // The pepper is what stops an attacker enumerating the (small) space of Nigerian
    // mobile numbers against a stolen table.
    expect(hashPhone('2348012345678', PEPPER)).not.toBe(
      hashPhone('2348012345678', 'b'.repeat(64)),
    );
  });

  it('never returns the phone number itself', () => {
    expect(hashPhone('2348012345678', PEPPER)).not.toContain('2348012345678');
  });

  it('refuses a missing or weak pepper rather than degrading silently', () => {
    expect(() => hashPhone('2348012345678', '')).toThrow(/pepper/i);
    expect(() => hashPhone('2348012345678', 'tooshort')).toThrow(/pepper/i);
  });
});

describe('hashesEqual', () => {
  it('compares equal hashes', () => {
    const h = hashPhone('2348012345678', PEPPER);
    expect(hashesEqual(h, h)).toBe(true);
  });

  it('rejects different hashes', () => {
    expect(hashesEqual(hashPhone('2348012345678', PEPPER), hashPhone('2348000000000', PEPPER))).toBe(
      false,
    );
  });

  it('rejects a length mismatch without throwing', () => {
    expect(hashesEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('redact — phone numbers', () => {
  it.each([
    'call me on 08012345678',
    'my number is +2348012345678',
    'reach my husband on +234 801 234 5678',
    'call 0801-234-5678',
  ])('removes the number from %j', (text) => {
    const result = redact(text);
    expect(result.text).not.toMatch(/\d{7,}/);
    expect(result.total).toBeGreaterThan(0);
  });

  it('substitutes a readable placeholder', () => {
    expect(redactText('call me on 08012345678')).toContain('[phone]');
  });
});

describe('redact — other identifiers', () => {
  it('removes email addresses', () => {
    const r = redact('email me at mama@example.com please');
    expect(r.text).toContain('[email]');
    expect(r.text).not.toContain('mama@example.com');
    expect(r.counts.email).toBe(1);
  });

  it('removes URLs', () => {
    expect(redactText('see https://example.com/x')).toContain('[link]');
    expect(redactText('see www.example.com')).toContain('[link]');
  });

  it('removes an NIN', () => {
    const r = redact('my NIN is 12345678901');
    expect(r.text).toContain('[id]');
    expect(r.text).not.toMatch(/\d{11}/);
  });

  it('does not leave digits behind from inside an email', () => {
    expect(redactText('contact mama2024@example.com')).not.toMatch(/\d{4}/);
  });
});

describe('redact — clinical values must survive', () => {
  it.each([
    'the baby is 6 days old',
    'her temperature is 38.5 degrees',
    'I am 2 weeks postpartum',
    'she is 32 years old',
    'baby weighs 3.2 kg',
    'it started 3 days ago',
  ])('preserves %j', (text) => {
    expect(redactText(text)).toBe(text);
  });

  it('keeps clinical numbers while removing a phone number in the same message', () => {
    const out = redactText('baby is 6 days old, call me on 08012345678');
    expect(out).toContain('6 days old');
    expect(out).toContain('[phone]');
  });
});

describe('redact — reporting', () => {
  it('counts each kind separately', () => {
    const r = redact('call 08012345678 or email mama@example.com');
    expect(r.counts.phone).toBe(1);
    expect(r.counts.email).toBe(1);
    expect(r.total).toBe(2);
  });

  it('reports nothing removed from clean clinical text', () => {
    const r = redact('the baby has a fever and is not feeding');
    expect(r.total).toBe(0);
    expect(r.text).toBe('the baby has a fever and is not feeding');
  });

  it('handles empty and undefined input', () => {
    expect(redact('').text).toBe('');
    expect(redact(undefined as unknown as string).text).toBe('');
  });

  it('is stable across repeated calls', () => {
    // Guards against a shared regex lastIndex making redaction order-dependent.
    for (let i = 0; i < 5; i++) {
      expect(redactText('call me on 08012345678')).toContain('[phone]');
    }
  });

  it('removes several numbers in one message', () => {
    const out = redactText('call 08012345678 or 08087654321');
    expect(out).not.toMatch(/\d{7,}/);
  });
});

describe('looksRedacted', () => {
  it('accepts text with no identifier-length digit runs', () => {
    expect(looksRedacted('baby is 6 days old and has [phone]')).toBe(true);
  });

  it('rejects text still containing a long digit run', () => {
    expect(looksRedacted('call me on 08012345678')).toBe(false);
    expect(looksRedacted('+2348012345678')).toBe(false);
  });

  it('agrees with redact() on its own output', () => {
    const samples = [
      'call me on 08012345678',
      'email mama@example.com',
      'my NIN is 12345678901',
      'baby is 6 days old',
    ];
    for (const s of samples) {
      expect(looksRedacted(redactText(s))).toBe(true);
    }
  });
});
