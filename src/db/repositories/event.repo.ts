/**
 * Webhook idempotency ledger and audit trail.
 *
 * Meta retries a webhook delivery when it does not receive a prompt 200. Without the
 * claim below, a retry produces a second triage message to the mother — which, for an
 * emergency directive, is confusing at exactly the wrong moment.
 */

import type { Db } from '../pool';

export class WebhookEventRepository {
  constructor(private readonly db: Db) {}

  /**
   * Attempt to claim a WhatsApp message ID for processing.
   *
   * @returns true if this call won the claim and should process the message; false if it
   *          was already claimed, meaning this is a retry and must be dropped.
   */
  async claim(waMessageId: string): Promise<boolean> {
    const row = await this.db.one<{ wa_message_id: string }>(
      `INSERT INTO webhook_events (wa_message_id)
       VALUES ($1)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING wa_message_id`,
      [waMessageId],
    );
    return row !== undefined;
  }

  async markProcessed(waMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_events
          SET status = 'processed', processed_at = NOW()
        WHERE wa_message_id = $1`,
      [waMessageId],
    );
  }

  async markFailed(waMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_events
          SET status = 'failed', processed_at = NOW()
        WHERE wa_message_id = $1`,
      [waMessageId],
    );
  }

  /**
   * Release a claim so the message can be processed again.
   *
   * Used when processing fails before anything was sent to the mother, so that Meta's
   * retry is allowed to succeed rather than being swallowed by the ledger.
   */
  async release(waMessageId: string): Promise<void> {
    await this.db.query(`DELETE FROM webhook_events WHERE wa_message_id = $1`, [waMessageId]);
  }

  /** Remove ledger entries older than `days`. Meta stops retrying long before this. */
  async purgeOlderThan(days: number): Promise<number> {
    const rows = await this.db.query<{ wa_message_id: string }>(
      `DELETE FROM webhook_events
        WHERE received_at < NOW() - ($1 || ' days')::interval
        RETURNING wa_message_id`,
      [String(days)],
    );
    return rows.length;
  }
}

/** Safety-relevant events. Kept separate from the clinical outcome record. */
export type AuditEvent =
  | 'CONSENT_GIVEN'
  | 'CONSENT_DECLINED'
  | 'RED_FLAG_HIT'
  | 'DISTRESS_DETECTED'
  | 'EMERGENCY_ISSUED'
  | 'LLM_FAILOVER'
  | 'CITATION_REJECTED'
  | 'RATCHET_BLOCKED_DOWNGRADE'
  | 'SAFETY_CHECK_ESCALATED'
  | 'SESSION_ABANDONED'
  | 'COMMAND_USED'
  | 'WEBHOOK_REJECTED';

export class AuditRepository {
  constructor(private readonly db: Db) {}

  /**
   * Record a safety event.
   *
   * Never throws: an audit write failing must not take down the mother's assessment. The
   * failure surfaces through logs and the readiness check instead.
   */
  async record(
    event: AuditEvent,
    detail: Record<string, unknown> = {},
    sessionId: string | null = null,
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_log (session_id, event, detail) VALUES ($1, $2, $3::jsonb)`,
        [sessionId, event, JSON.stringify(detail)],
      );
    } catch {
      /* deliberately swallowed — see doc comment */
    }
  }

  async listForSession(sessionId: string): Promise<Array<{ event: string; detail: unknown; created_at: Date }>> {
    return this.db.query(
      `SELECT event, detail, created_at FROM audit_log
        WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
  }

  async countByEvent(event: AuditEvent): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE event = $1`,
      [event],
    );
    return Number(row?.count ?? 0);
  }
}
