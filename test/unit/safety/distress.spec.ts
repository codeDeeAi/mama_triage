import { DISTRESS_REGISTER, detectDistress } from '../../../src/safety/distress';

describe('detectDistress — self-harm', () => {
  it.each([
    'I want to kill myself',
    'I am thinking about suicide',
    'I want to end my life',
    'I do not want to live anymore',
    'everyone would be better off dead',
    'I want to die',
    'I wan die',
  ])('detects %j', (text) => {
    const result = detectDistress(text);
    expect(result.detected).toBe(true);
    expect(result.categories).toContain('self_harm');
    expect(result.needsMentalHealthReferral).toBe(true);
  });
});

describe('detectDistress — infant harm', () => {
  it.each([
    'sometimes I want to hurt my baby',
    'I feel like I could harm the baby',
    'I do not want this baby',
  ])('detects %j', (text) => {
    const result = detectDistress(text);
    expect(result.categories).toContain('infant_harm');
    expect(result.needsMentalHealthReferral).toBe(true);
  });
});

describe('detectDistress — perceived death risk', () => {
  it.each([
    'I think my baby is dying',
    'she is dying please help',
    'pikin dey die',
    'please save my baby',
  ])('detects %j', (text) => {
    expect(detectDistress(text).categories).toContain('perceived_death_risk');
  });

  it('does not request a mental-health referral for clinical fear alone', () => {
    const result = detectDistress('I think my baby is dying');
    expect(result.detected).toBe(true);
    expect(result.needsMentalHealthReferral).toBe(false);
  });
});

describe('detectDistress — acute panic', () => {
  it.each([
    'help me please',
    'please please please',
    'I do not know what to do',
    'this is an emergency',
    'abeg help',
    'I dey fear',
  ])('detects %j', (text) => {
    expect(detectDistress(text).categories).toContain('acute_panic');
  });
});

describe('detectDistress — negation is deliberately NOT applied', () => {
  it('fires on phrasings that embed their own negation', () => {
    // "I don't want to live" must fire. Stripping negations here would remove
    // exactly the strings that matter.
    expect(detectDistress("I don't want to live").detected).toBe(true);
    expect(detectDistress('I do not want to live').detected).toBe(true);
  });
});

describe('detectDistress — no false positives on ordinary clinical text', () => {
  it.each([
    'the baby has a fever since yesterday',
    'how often should I feed him?',
    'my stitches are healing well',
    'I am tired but coping fine',
    'when should I come for the next check up',
  ])('does not fire on %j', (text) => {
    const result = detectDistress(text);
    expect(result.detected).toBe(false);
    expect(result.categories).toHaveLength(0);
    expect(result.needsMentalHealthReferral).toBe(false);
  });

  it('handles empty input', () => {
    const result = detectDistress('');
    expect(result.detected).toBe(false);
    expect(result.evidence).toHaveLength(0);
  });
});

describe('detectDistress — reporting', () => {
  it('records the matched text as evidence for the audit log', () => {
    const result = detectDistress('I want to kill myself');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0]?.toLowerCase()).toContain('kill myself');
  });

  it('reports several categories at once', () => {
    const result = detectDistress('help me please, I want to die, the baby is dying');
    expect(result.categories.length).toBeGreaterThanOrEqual(2);
    expect(result.needsMentalHealthReferral).toBe(true);
  });

  it('de-duplicates repeated hits within a category', () => {
    const result = detectDistress('I want to die. I want to die. I want to die.');
    expect(result.categories.filter((c) => c === 'self_harm')).toHaveLength(1);
  });

  it('is case insensitive', () => {
    expect(detectDistress('I WANT TO KILL MYSELF').detected).toBe(true);
  });

  it('is stateless across calls', () => {
    for (let i = 0; i < 5; i++) {
      expect(detectDistress('I want to die').detected).toBe(true);
      expect(detectDistress('the baby is feeding well').detected).toBe(false);
    }
  });

  it('exposes its register for clinical review', () => {
    expect(DISTRESS_REGISTER.length).toBeGreaterThan(0);
    for (const rule of DISTRESS_REGISTER) {
      expect(rule.patterns.length).toBeGreaterThan(0);
      expect(typeof rule.needsMentalHealthReferral).toBe('boolean');
    }
  });
});
