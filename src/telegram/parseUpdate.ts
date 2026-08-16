/**
 * Parse a Telegram `Update` into the transport-neutral `InboundMessage` the handler
 * already understands.
 *
 * The webhook body is untrusted input from the public internet, so it is validated
 * against a schema rather than accessed optimistically. A malformed or hostile payload
 * yields "ignore", not a crash inside the handler.
 */

import { z } from 'zod';
import type { InboundMessage } from '../whatsapp/types';

const user = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  language_code: z.string().optional(),
});

const message = z.object({
  message_id: z.number(),
  from: user.optional(),
  chat: z.object({ id: z.number() }),
  date: z.number().optional(),
  text: z.string().optional(),
});

const callbackQuery = z.object({
  id: z.string(),
  from: user,
  data: z.string().optional(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number() }),
      date: z.number().optional(),
    })
    .optional(),
});

export const UpdateSchema = z.object({
  update_id: z.number(),
  message: message.optional(),
  edited_message: message.optional(),
  callback_query: callbackQuery.optional(),
});

export type TelegramUpdate = z.infer<typeof UpdateSchema>;

export interface ParsedUpdate extends InboundMessage {
  /** Present when the update came from a button tap; must be acknowledged. */
  callbackQueryId?: string;
  /** Payload from a `/start <payload>` deep link, used to link a registration. */
  startPayload?: string;
  /**
   * True when the message was `/start`, with or without a payload.
   *
   * The text is rewritten to a greeting below, which loses the distinction — and the
   * handler needs it: `/start` from a mother who is already mid-assessment should show
   * her what the bot can do, not be answered as though she had typed "hello".
   */
  isStartCommand?: boolean;
  /** Telegram's own language hint, e.g. "en", "en-GB". A weak signal, but free. */
  clientLanguage?: string;
}

/**
 * Extract a usable message, or null.
 *
 * Returns null for updates this system does not act on — edited messages, joins, photos —
 * rather than inventing an empty message that would enter the state machine.
 */
export function parseUpdate(payload: unknown): ParsedUpdate | null {
  const parsed = UpdateSchema.safeParse(payload);
  if (!parsed.success) return null;
  const u = parsed.data;

  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = cq.message?.chat.id ?? cq.from.id;
    return {
      // Telegram has no per-message ID that is unique across chats, so the idempotency
      // key is composed. `update_id` is unique per bot and is what a redelivery repeats.
      channel: 'telegram',
      waMessageId: `tg.cb.${u.update_id}`,
      from: String(chatId),
      // The button's visible label is not sent back, only callback_data, so the data
      // doubles as the text for logging and transcript purposes.
      text: cq.data ?? '',
      replyId: cq.data ?? '',
      kind: 'interactive',
      timestamp: cq.message?.date ?? Math.floor(Date.now() / 1000),
      phoneNumberId: 'telegram',
      callbackQueryId: cq.id,
      ...(cq.from.language_code ? { clientLanguage: cq.from.language_code } : {}),
    };
  }

  const m = u.message;
  if (!m) return null;

  // Non-text messages (photo, voice, location) arrive with no `text`. Surfaced as
  // 'unsupported' so the mother is told, rather than silently ignored.
  if (m.text === undefined) {
    return {
      channel: 'telegram',
      waMessageId: `tg.${u.update_id}`,
      from: String(m.chat.id),
      text: '',
      kind: 'unsupported',
      timestamp: m.date ?? Math.floor(Date.now() / 1000),
      phoneNumberId: 'telegram',
      ...(m.from?.language_code ? { clientLanguage: m.from.language_code } : {}),
    };
  }

  // `/start` may carry a deep-link payload: t.me/Bot?start=<payload>. That is how a
  // web registration is linked to a Telegram chat without asking for a phone number.
  const startMatch = /^\/start(?:\s+(\S+))?$/.exec(m.text.trim());
  const startPayload = startMatch?.[1];

  return {
    channel: 'telegram',
    waMessageId: `tg.${u.update_id}`,
    from: String(m.chat.id),
    // A bare "/start" is a greeting, not something to feed the safety scan as symptom
    // text. It is normalised so the handler treats it as an opening message.
    text: startMatch ? 'hello' : m.text,
    kind: 'text',
    timestamp: m.date ?? Math.floor(Date.now() / 1000),
    phoneNumberId: 'telegram',
    ...(startMatch ? { isStartCommand: true } : {}),
    ...(startPayload ? { startPayload } : {}),
    ...(m.from?.language_code ? { clientLanguage: m.from.language_code } : {}),
  };
}

/** True when the update carries nothing this system acts on. */
export function isIgnorable(payload: unknown): boolean {
  return parseUpdate(payload) === null;
}
