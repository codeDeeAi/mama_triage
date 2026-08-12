/**
 * Follow-up repository.
 *
 * A follow-up reaches a mother on the channel she already uses, so it stores the same
 * channel-keyed identity hash the session does and no new identifier.
 */

import type { Db } from '../pool';
import type { Channel } from '../../privacy/hashPhone';
import type { Language } from '../../types';

export type FollowUpStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface FollowUpRow {
  id: string;
  session_id: string | null;
  identity_hash: string;
  recipient: string | null;
  channel: Channel;
  language: Language;
  display_name: string | null;
  reason: string;
  interval_days: number;
  due_at: Date;
  status: FollowUpStatus;
  attempts: number;
  sent_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export interface ScheduleInput {
  sessionId: string;
  identityHash: string;
  /** Plaintext address for delivery. Cleared once the follow-up completes. */
  recipient: string;
  channel: Channel;
  language: Language;
  displayName?: string | null;
  reason: string;
  intervalDays: number;
  dueAt: Date;
}

/** How many times to retry a send before giving up. */
export const MAX_ATTEMPTS = 3;

export class FollowUpRepository {
  constructor(private readonly db: Db) {}

  /**
   * Queue a follow-up.
   *
   * `ON CONFLICT DO NOTHING` against the partial unique index means re-running an
   * assessment for the same finding does not queue a second reminder. A mother who
   * messages twice about the same jaundice should be reminded once.
   */
  async schedule(input: ScheduleInput): Promise<FollowUpRow | null> {
    const row = await this.db.one<FollowUpRow>(
      `INSERT INTO follow_ups
         (session_id, identity_hash, recipient, channel, language, display_name,
          reason, interval_days, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        input.sessionId,
        input.identityHash,
        input.recipient,
        input.channel,
        input.language,
        input.displayName ?? null,
        input.reason,
        input.intervalDays,
        input.dueAt,
      ],
    );
    return row ?? null;
  }

  /**
   * Claim due follow-ups for sending.
   *
   * `FOR UPDATE SKIP LOCKED` inside a transaction is what makes this safe with more than
   * one instance running: two Cloud Run containers polling at the same moment take
   * disjoint sets rather than both sending the same reminder.
   */
  async claimDue(limit = 50, now: Date = new Date()): Promise<FollowUpRow[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<FollowUpRow>(
        `SELECT * FROM follow_ups
          WHERE status = 'pending' AND due_at <= $1
          ORDER BY due_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) return [];

      await tx.query(
        `UPDATE follow_ups SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)],
      );
      return rows;
    });
  }

  /** Mark sent and discard the plaintext address — it is not needed again. */
  async markSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE follow_ups
          SET status = 'sent', sent_at = NOW(), last_error = NULL, recipient = NULL
        WHERE id = $1`,
      [id],
    );
  }

  /**
   * Record a failure.
   *
   * Stays `pending` until the attempt budget is exhausted, so a transient outage retries
   * on the next run rather than silently dropping a clinically-indicated reminder.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE follow_ups
          SET status = CASE WHEN attempts >= $2 THEN 'failed'::followup_status_t
                            ELSE 'pending'::followup_status_t END,
              last_error = $3,
              -- Give up on retries and the address is discarded too.
              recipient = CASE WHEN attempts >= $2 THEN NULL ELSE recipient END
        WHERE id = $1`,
      [id, MAX_ATTEMPTS, error.slice(0, 500)],
    );
  }

  /**
   * Cancel pending follow-ups for a session.
   *
   * Used when a later assessment escalates to emergency: she has been told to go now, and
   * a reminder two days later would read as though the referral were optional.
   */
  async cancelForSession(sessionId: string, reason: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE follow_ups
          SET status = 'cancelled', last_error = $2, recipient = NULL
        WHERE session_id = $1 AND status = 'pending'
        RETURNING id`,
      [sessionId, reason],
    );
    return rows.length;
  }

  async listForSession(sessionId: string): Promise<FollowUpRow[]> {
    return this.db.query<FollowUpRow>(
      `SELECT * FROM follow_ups WHERE session_id = $1 ORDER BY due_at ASC`,
      [sessionId],
    );
  }

  /**
   * Discard addresses for anything no longer deliverable.
   *
   * Belt and braces: a row that somehow ends in a terminal state without going through
   * markSent should not keep a plaintext address indefinitely. Run alongside the other
   * housekeeping.
   */
  async purgeStaleRecipients(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE follow_ups
          SET recipient = NULL
        WHERE recipient IS NOT NULL
          AND (status <> 'pending' OR due_at < NOW() - INTERVAL '7 days')
        RETURNING id`,
    );
    return rows.length;
  }

  /** Delivery figures for the report. */
  async stats(): Promise<Record<FollowUpStatus, number>> {
    const rows = await this.db.query<{ status: FollowUpStatus; n: string }>(
      `SELECT status, count(*)::text AS n FROM follow_ups GROUP BY status`,
    );
    const out: Record<FollowUpStatus, number> = {
      pending: 0, sent: 0, failed: 0, cancelled: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
