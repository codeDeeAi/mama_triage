import { dueAt, followUpMessage, planFollowUp } from '../../../src/orchestrator/followUp';
import type { Slots } from '../../../src/types';

const plan = (urgency: 'self_care' | 'facility_visit' | 'emergency', slots: Slots = {}) =>
  planFollowUp({ urgency, pathway: 'neonatal', slots });

describe('planFollowUp — WHO IMCI intervals', () => {
  it('schedules jaundice at 1 day', () => {
    const p = plan('facility_visit', { jaundice: 'face_only' });
    expect(p).toMatchObject({ reason: 'jaundice', intervalDays: 1 });
    expect(p?.rationale).toMatch(/JAUNDICE/);
  });

  it('schedules local bacterial infection at 2 days', () => {
    expect(plan('facility_visit', { cord_appearance: 'red_or_discharging' })).toMatchObject({
      reason: 'local_bacterial_infection',
      intervalDays: 2,
    });
  });

  it('schedules a feeding problem at 2 days', () => {
    expect(plan('facility_visit', { feeding: 'reduced' })).toMatchObject({
      reason: 'feeding_problem',
      intervalDays: 2,
    });
  });

  it('takes the shortest interval when several apply', () => {
    // Jaundice is 1 day; the others are 2. Reminding at 2 days would miss the window.
    const p = plan('facility_visit', {
      jaundice: 'face_only',
      cord_appearance: 'red_or_discharging',
    });
    expect(p?.intervalDays).toBe(1);
  });

  it('falls back to the routine 2-day interval', () => {
    expect(plan('facility_visit')).toMatchObject({
      reason: 'facility_visit_general',
      intervalDays: 2,
    });
  });
});

describe('planFollowUp — when NOT to schedule', () => {
  it('schedules nothing after an emergency', () => {
    // She has been told to go now. A reminder in two days would read as though the
    // referral were optional.
    expect(plan('emergency', { jaundice: 'to_palms_soles' })).toBeNull();
  });

  it('schedules nothing for self-care', () => {
    // IMCI pairs the green classification with "when to return immediately" advice, which
    // the renderer already includes, rather than a scheduled visit.
    expect(plan('self_care')).toBeNull();
  });

  it('schedules nothing on the maternal pathway', () => {
    // IMCI does not specify maternal intervals and the FMOH postnatal guideline is not
    // sourced. Inventing an interval would be inventing clinical advice.
    expect(
      planFollowUp({ urgency: 'facility_visit', pathway: 'maternal', slots: {} }),
    ).toBeNull();
  });
});

describe('dueAt', () => {
  it('adds the prescribed number of days', () => {
    const from = new Date('2026-08-12T14:00:00Z');
    const due = dueAt({ reason: 'jaundice', intervalDays: 1, rationale: '' }, from);
    expect(due.toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  it('sends in the morning rather than whenever she happened to message', () => {
    const due = dueAt(
      { reason: 'x', intervalDays: 2, rationale: '' },
      new Date('2026-08-12T03:17:00Z'),
    );
    expect(due.getUTCHours()).toBe(8); // 09:00 WAT
  });

  it('never schedules a reminder in the past', () => {
    const from = new Date('2026-08-12T23:50:00Z');
    const due = dueAt({ reason: 'x', intervalDays: 0, rationale: '' }, from);
    expect(due.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('followUpMessage', () => {
  it('asks her to come back rather than attempting triage', () => {
    // The reminder is one-way until she replies, so it must not start an assessment it
    // cannot finish.
    const body = followUpMessage('Amina', 'en');
    expect(body).toMatch(/How is your baby now/);
    expect(body).toMatch(/Reply and I will ask/);
  });

  it('repeats the referral instruction, since things may have worsened', () => {
    expect(followUpMessage('Amina', 'en')).toMatch(/nearest health facility/i);
    expect(followUpMessage('Amina', 'pcm')).toMatch(/health centre wey dey near you/i);
  });

  it('works without a name', () => {
    expect(followUpMessage(null, 'en')).toMatch(/^Hello, this is MamaTriage/);
  });

  it('writes Pidgin properly', () => {
    const body = followUpMessage('Amina', 'pcm');
    expect(body).toMatch(/How your pikin dey now/);
  });
});
