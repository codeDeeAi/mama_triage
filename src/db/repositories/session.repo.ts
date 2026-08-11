/**
 * Session repository.
 *
 * Sessions are keyed by `wa_id_hash` — the HMAC of the phone number. The raw number never
 * reaches this layer.
 */

import type { Db } from '../pool';
import type { Language, Pathway, SessionState, Slots, Urgency } from '../../types';

export interface SessionRow {
  id: string;
  wa_id_hash: string;
  pathway: Pathway;
  state: SessionState;
  language: Language;
  slots: Slots;
  urgency_current: Urgency | null;
  consent_at: Date | null;
  started_at: Date;
  last_activity_at: Date;
  completed_at: Date | null;
}

/** States in which a session is no longer accepting assessment input. */
const TERMINAL_STATES: readonly SessionState[] = [
  'completed',
  'abandoned',
  'escalated',
];

export class SessionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Find the active session for a caller, or null.
   *
   * A session is active when it is not terminal and has seen activity within the TTL.
   * A mother returning the next day starts fresh rather than resuming a stale
   * assessment mid-question.
   */
  async findActive(waIdHash: string, ttlMinutes: number): Promise<SessionRow | null> {
    const row = await this.db.one<SessionRow>(
      `SELECT * FROM sessions
        WHERE wa_id_hash = $1
          AND state <> ALL($2::session_state_t[])
          AND last_activity_at > NOW() - ($3 || ' minutes')::interval
        ORDER BY last_activity_at DESC
        LIMIT 1`,
      [waIdHash, TERMINAL_STATES, String(ttlMinutes)],
    );
    return row ?? null;
  }

  async create(waIdHash: string, language: Language = 'en'): Promise<SessionRow> {
    const row = await this.db.one<SessionRow>(
      `INSERT INTO sessions (wa_id_hash, language, state)
       VALUES ($1, $2, 'new')
       RETURNING *`,
      [waIdHash, language],
    );
    if (!row) throw new Error('failed to create session');
    return row;
  }

  /** Find the active session or open a new one. */
  async findOrCreate(
    waIdHash: string,
    ttlMinutes: number,
    language: Language = 'en',
  ): Promise<{ session: SessionRow; created: boolean }> {
    const existing = await this.findActive(waIdHash, ttlMinutes);
    if (existing) return { session: existing, created: false };
    return { session: await this.create(waIdHash, language), created: true };
  }

  async setState(id: string, state: SessionState): Promise<void> {
    // $2 is cast explicitly: without it Postgres deduces session_state_t from the
    // assignment and text from the IN comparison, and rejects the statement with
    // "inconsistent types deduced for parameter $2".
    await this.db.query(
      `UPDATE sessions
          SET state = $2::session_state_t,
              last_activity_at = NOW(),
              completed_at = CASE
                  WHEN $2::session_state_t
                       IN ('completed','abandoned','escalated') THEN NOW()
                  ELSE completed_at
              END
        WHERE id = $1`,
      [id, state],
    );
  }

  async setPathway(id: string, pathway: Pathway): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET pathway = $2, last_activity_at = NOW() WHERE id = $1`,
      [id, pathway],
    );
  }

  async setLanguage(id: string, language: Language): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET language = $2, last_activity_at = NOW() WHERE id = $1`,
      [id, language],
    );
  }

  async recordConsent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions
          SET consent_at = NOW(), state = 'choosing_pathway', last_activity_at = NOW()
        WHERE id = $1 AND consent_at IS NULL`,
      [id],
    );
  }

  /** Merge newly extracted slot values into the stored set. */
  async mergeSlots(id: string, slots: Slots): Promise<void> {
    if (Object.keys(slots).length === 0) return;
    await this.db.query(
      `UPDATE sessions
          SET slots = slots || $2::jsonb, last_activity_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(slots)],
    );
  }

  /**
   * Raise the session's urgency high-water mark.
   *
   * The `WHERE` clause makes this a no-op rather than an error when the proposed urgency
   * is not an escalation. The database trigger rejects an actual downgrade, so a bug that
   * bypassed this guard would still fail loudly rather than silently de-escalate.
   */
  async raiseUrgency(id: string, urgency: Urgency): Promise<void> {
    await this.db.query(
      `UPDATE sessions
          SET urgency_current = $2, last_activity_at = NOW()
        WHERE id = $1
          AND (urgency_current IS NULL
               OR CASE urgency_current
                    WHEN 'self_care' THEN 0 WHEN 'facility_visit' THEN 1 ELSE 2 END
                < CASE $2::urgency_t
                    WHEN 'self_care' THEN 0 WHEN 'facility_visit' THEN 1 ELSE 2 END)`,
      [id, urgency],
    );
  }

  async touch(id: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET last_activity_at = NOW() WHERE id = $1`, [id]);
  }

  async findById(id: string): Promise<SessionRow | null> {
    return (await this.db.one<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id])) ?? null;
  }

  /** Mark stale non-terminal sessions abandoned. Run periodically. */
  async expireStale(ttlMinutes: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE sessions
          SET state = 'abandoned', completed_at = NOW()
        WHERE state <> ALL($1::session_state_t[])
          AND last_activity_at < NOW() - ($2 || ' minutes')::interval
        RETURNING id`,
      [TERMINAL_STATES, String(ttlMinutes)],
    );
    return rows.length;
  }
}
