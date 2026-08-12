/**
 * Registration repository.
 *
 * A registration is how a mother joins and which channel she chose. It holds the minimum
 * needed to reach her on that channel and nothing else — no phone number for Telegram, no
 * Telegram token for WhatsApp.
 */

import { randomBytes } from 'node:crypto';
import type { Db } from '../pool';
import type { Channel } from '../../privacy/hashPhone';

export interface RegistrationRow {
  id: string;
  display_name: string;
  channel: Channel;
  identity_hash: string | null;
  link_token: string | null;
  linked_at: Date | null;
  contact_consent_at: Date;
  created_at: Date;
}

/** URL-safe, unguessable, and short enough for a t.me deep link. */
export function generateLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

export class RegistrationRepository {
  constructor(private readonly db: Db) {}

  /** Register for WhatsApp. The phone number must already be hashed by the caller. */
  async createWhatsApp(displayName: string, identityHash: string): Promise<RegistrationRow> {
    const row = await this.db.one<RegistrationRow>(
      `INSERT INTO registrations (display_name, channel, identity_hash)
       VALUES ($1, 'whatsapp', $2)
       RETURNING *`,
      [displayName, identityHash],
    );
    if (!row) throw new Error('failed to create registration');
    return row;
  }

  /**
   * Register for Telegram.
   *
   * No identifier is stored: the token is issued, and the chat is bound only when she
   * opens the bot. Until then the row contains a display name and nothing that could
   * reach or identify her.
   */
  async createTelegram(displayName: string): Promise<RegistrationRow> {
    const row = await this.db.one<RegistrationRow>(
      `INSERT INTO registrations (display_name, channel, link_token)
       VALUES ($1, 'telegram', $2)
       RETURNING *`,
      [displayName, generateLinkToken()],
    );
    if (!row) throw new Error('failed to create registration');
    return row;
  }

  /**
   * Bind a Telegram chat to its registration when she sends `/start <token>`.
   *
   * The token is consumed: `linked_at IS NULL` in the WHERE clause makes it single-use,
   * so a link forwarded to someone else cannot attach a second chat to the same
   * registration.
   *
   * @returns the registration, or null when the token is unknown or already used.
   */
  async linkTelegram(token: string, identityHash: string): Promise<RegistrationRow | null> {
    const row = await this.db.one<RegistrationRow>(
      `UPDATE registrations
          SET identity_hash = $2, linked_at = NOW()
        WHERE link_token = $1 AND linked_at IS NULL
        RETURNING *`,
      [token, identityHash],
    );
    return row ?? null;
  }

  /** Look up by channel identity, to greet a returning mother by name. */
  async findByIdentity(identityHash: string): Promise<RegistrationRow | null> {
    return (
      (await this.db.one<RegistrationRow>(
        `SELECT * FROM registrations WHERE identity_hash = $1 ORDER BY created_at DESC LIMIT 1`,
        [identityHash],
      )) ?? null
    );
  }

  async findByToken(token: string): Promise<RegistrationRow | null> {
    return (
      (await this.db.one<RegistrationRow>(
        `SELECT * FROM registrations WHERE link_token = $1`,
        [token],
      )) ?? null
    );
  }

  /** Registration counts by channel — evidence for the report's uptake section. */
  async statsByChannel(): Promise<Array<{ channel: Channel; total: number; linked: number }>> {
    const rows = await this.db.query<{ channel: Channel; total: string; linked: string }>(
      `SELECT channel,
              count(*)::text AS total,
              count(*) FILTER (WHERE identity_hash IS NOT NULL)::text AS linked
         FROM registrations
        GROUP BY channel
        ORDER BY channel`,
    );
    return rows.map((r) => ({
      channel: r.channel,
      total: Number(r.total),
      linked: Number(r.linked),
    }));
  }
}
