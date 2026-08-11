/**
 * Message repository.
 *
 * The only place message text is written. Every body passes through `redact()` first, and
 * `looksRedacted()` is asserted before the INSERT — so a future code path that forgets to
 * redact fails loudly instead of quietly persisting a phone number.
 */

import type { Db } from '../pool';
import type { Direction, Language } from '../../types';
import { looksRedacted, redact } from '../../privacy/redact';

export interface MessageRow {
  id: string;
  session_id: string;
  direction: Direction;
  wa_message_id: string | null;
  body_redacted: string;
  detected_lang: Language | null;
  latency_ms: number | null;
  created_at: Date;
}

export interface RecordMessageInput {
  sessionId: string;
  direction: Direction;
  /** Raw text. Redacted here — callers must not pre-redact. */
  body: string;
  waMessageId?: string | null;
  detectedLang?: Language | null;
  latencyMs?: number | null;
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  async record(input: RecordMessageInput): Promise<MessageRow> {
    const { text: bodyRedacted } = redact(input.body);

    /* istanbul ignore next -- defence in depth: unreachable while redact() is correct,
       but a silent PII leak is the one failure this layer must never allow. */
    if (!looksRedacted(bodyRedacted)) {
      throw new Error(
        'refusing to persist a message body that still contains identifier-length digits',
      );
    }

    const row = await this.db.one<MessageRow>(
      `INSERT INTO messages
         (session_id, direction, wa_message_id, body_redacted, detected_lang, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING *`,
      [
        input.sessionId,
        input.direction,
        input.waMessageId ?? null,
        bodyRedacted,
        input.detectedLang ?? null,
        input.latencyMs ?? null,
      ],
    );

    if (row) return row;

    // ON CONFLICT fired: this exact WhatsApp message is already stored. Return the
    // existing row so a retried delivery is idempotent rather than an error.
    const existing = await this.db.one<MessageRow>(
      `SELECT * FROM messages WHERE wa_message_id = $1`,
      [input.waMessageId],
    );
    if (!existing) throw new Error('failed to record message');
    return existing;
  }

  /** Full transcript for a session, oldest first. */
  async listForSession(sessionId: string): Promise<MessageRow[]> {
    return this.db.query<MessageRow>(
      `SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
  }

  /** Most recent `limit` messages, oldest first — the LLM's conversation window. */
  async recentForSession(sessionId: string, limit = 20): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE session_id = $1
          ORDER BY created_at DESC, id DESC LIMIT $2
       ) recent ORDER BY created_at ASC, id ASC`,
      [sessionId, limit],
    );
    return rows;
  }

  async countForSession(sessionId: string): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE session_id = $1`,
      [sessionId],
    );
    return Number(row?.count ?? 0);
  }
}
