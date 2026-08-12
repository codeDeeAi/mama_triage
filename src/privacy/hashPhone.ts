/**
 * Phone number anonymisation.
 *
 * The mother's phone number is NEVER persisted. What goes into `sessions.wa_id_hash` is
 * HMAC-SHA256(normalised phone, pepper), with the pepper held in Secret Manager and never
 * in the database. This means:
 *
 *   - the database is useless for identifying a person even if it leaks in full;
 *   - session continuity across messages still works, because the same number always
 *     produces the same hash;
 *   - the mapping cannot be reversed by brute force without the pepper, which matters
 *     because the space of Nigerian mobile numbers is small enough (~10^10) to enumerate
 *     against an unsalted hash in minutes.
 *
 * That last point is the reason this is an HMAC with a secret rather than a plain
 * SHA-256: a bare hash of a phone number is not anonymisation.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Normalise a WhatsApp `wa_id` to a canonical form before hashing.
 *
 * The Cloud API delivers numbers in E.164 without the leading `+` (e.g. `2348012345678`),
 * but defensive normalisation keeps the hash stable if a caller passes a formatted
 * variant. Without this, `+234 801 234 5678` and `2348012345678` would hash differently
 * and silently split one mother's session history in two.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) {
    throw new Error('cannot normalise an empty phone number');
  }

  // Nigerian local format: 0801... → 234801...
  if (digits.startsWith('0') && digits.length === 11) {
    return `234${digits.slice(1)}`;
  }
  // Leading international prefix: 00234... → 234...
  if (digits.startsWith('00')) {
    return digits.slice(2);
  }
  return digits;
}

/**
 * Hash a phone number for storage.
 *
 * @param phone  Raw `wa_id` or any formatted variant.
 * @param pepper Secret from config; must be at least 32 characters (enforced at boot).
 * @returns 64-character lowercase hex digest, matching `sessions.wa_id_hash CHAR(64)`.
 */
export function hashPhone(phone: string, pepper: string): string {
  if (!pepper || pepper.length < 32) {
    // Defence in depth: config validation already enforces this, but a weak pepper
    // reaching here would silently degrade anonymisation rather than fail loudly.
    throw new Error('phone hash pepper is missing or too short');
  }
  return createHmac('sha256', pepper).update(normalisePhone(phone)).digest('hex');
}

/**
 * Channels a mother can reach the system on.
 *
 * Kept here because identity hashing is channel-dependent: a Telegram chat ID is not a
 * phone number and must not go through phone normalisation.
 */
export type Channel = 'whatsapp' | 'telegram';

/**
 * Hash a caller's identity for storage.
 *
 * Two things this gets right that a bare `hashPhone` did not:
 *
 *   1. **Telegram chat IDs are not phone numbers.** Running one through
 *      `normalisePhone` would apply Nigerian mobile rules to an unrelated integer — an
 *      11-digit chat ID beginning with 0 would silently have "234" prepended.
 *   2. **The channel is part of the identity.** Without it, a Telegram chat ID that
 *      happened to equal a normalised phone number would collide into one session,
 *      merging two different people's clinical history.
 */
export function hashIdentity(channel: Channel, identifier: string, pepper: string): string {
  if (!pepper || pepper.length < 32) {
    throw new Error('identity hash pepper is missing or too short');
  }
  const normalised =
    channel === 'whatsapp' ? normalisePhone(identifier) : identifier.trim();

  if (normalised.length === 0) {
    throw new Error('cannot hash an empty identifier');
  }
  return createHmac('sha256', pepper).update(`${channel}:${normalised}`).digest('hex');
}

/**
 * Constant-time comparison of two hashes.
 *
 * Used where a hash is compared against a stored value; avoids leaking information
 * through timing. Length mismatch short-circuits, since `timingSafeEqual` throws on
 * unequal buffer lengths.
 */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
