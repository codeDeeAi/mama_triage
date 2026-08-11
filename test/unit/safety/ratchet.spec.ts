import {
  isDeEscalation,
  isMoreUrgent,
  ratchet,
  ratchetAll,
} from '../../../src/safety/ratchet';
import { URGENCY_VALUES, type Urgency } from '../../../src/types';

/**
 * The ratchet is the single most safety-critical function in the codebase. These tests
 * are exhaustive over the 3x3 space rather than illustrative.
 */
describe('ratchet', () => {
  it('returns the proposed urgency when nothing is set yet', () => {
    for (const proposed of URGENCY_VALUES) {
      expect(ratchet(null, proposed)).toBe(proposed);
      expect(ratchet(undefined, proposed)).toBe(proposed);
    }
  });

  // Exhaustive truth table: result must be the more urgent of the two, always.
  const expected: Record<Urgency, Record<Urgency, Urgency>> = {
    self_care: {
      self_care: 'self_care',
      facility_visit: 'facility_visit',
      emergency: 'emergency',
    },
    facility_visit: {
      self_care: 'facility_visit', // de-escalation refused
      facility_visit: 'facility_visit',
      emergency: 'emergency',
    },
    emergency: {
      self_care: 'emergency', // de-escalation refused
      facility_visit: 'emergency', // de-escalation refused
      emergency: 'emergency',
    },
  };

  it.each(URGENCY_VALUES)('never de-escalates from %s', (current) => {
    for (const proposed of URGENCY_VALUES) {
      expect(ratchet(current, proposed)).toBe(expected[current][proposed]);
    }
  });

  it('refuses to lower an emergency no matter how many times it is asked', () => {
    let urgency: Urgency = 'emergency';
    for (let i = 0; i < 50; i++) {
      urgency = ratchet(urgency, 'self_care');
    }
    expect(urgency).toBe('emergency');
  });
});

describe('ratchetAll', () => {
  it('returns null when there is nothing to combine', () => {
    expect(ratchetAll(null, [])).toBeNull();
  });

  it('preserves the current value when no proposals are given', () => {
    expect(ratchetAll('facility_visit', [])).toBe('facility_visit');
  });

  it('takes the maximum of several proposals', () => {
    expect(ratchetAll(null, ['self_care', 'emergency', 'facility_visit'])).toBe('emergency');
    expect(ratchetAll(null, ['self_care', 'self_care'])).toBe('self_care');
    expect(ratchetAll(null, ['facility_visit', 'self_care'])).toBe('facility_visit');
  });

  it('never drops below the current value', () => {
    expect(ratchetAll('emergency', ['self_care', 'facility_visit'])).toBe('emergency');
  });

  it('is order independent', () => {
    const a = ratchetAll(null, ['self_care', 'facility_visit', 'emergency']);
    const b = ratchetAll(null, ['emergency', 'facility_visit', 'self_care']);
    expect(a).toBe(b);
  });
});

describe('isDeEscalation', () => {
  it('is false when there is no prior urgency', () => {
    expect(isDeEscalation(null, 'self_care')).toBe(false);
    expect(isDeEscalation(undefined, 'self_care')).toBe(false);
  });

  it('detects an attempted downgrade', () => {
    expect(isDeEscalation('emergency', 'self_care')).toBe(true);
    expect(isDeEscalation('emergency', 'facility_visit')).toBe(true);
    expect(isDeEscalation('facility_visit', 'self_care')).toBe(true);
  });

  it('is false for equal or higher urgency', () => {
    expect(isDeEscalation('self_care', 'self_care')).toBe(false);
    expect(isDeEscalation('self_care', 'emergency')).toBe(false);
    expect(isDeEscalation('facility_visit', 'emergency')).toBe(false);
  });
});

describe('isMoreUrgent', () => {
  it('compares tiers correctly', () => {
    expect(isMoreUrgent('emergency', 'facility_visit')).toBe(true);
    expect(isMoreUrgent('facility_visit', 'self_care')).toBe(true);
    expect(isMoreUrgent('self_care', 'emergency')).toBe(false);
    expect(isMoreUrgent('emergency', 'emergency')).toBe(false);
  });
});
