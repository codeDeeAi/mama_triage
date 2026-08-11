/**
 * Parse and validate an inbound WhatsApp webhook payload.
 *
 * The webhook body is untrusted input from the public internet. It is validated against a
 * schema rather than accessed optimistically, so a malformed or hostile payload produces
 * a clean "ignore" rather than a crash inside the handler.
 *
 * A single webhook POST may carry several entries and changes. Meta also delivers status
 * callbacks (sent/delivered/read) through the same endpoint; those carry no `messages`
 * array and must be ignored, not treated as user input.
 */

import { z } from 'zod';
import type { InboundMessage } from './types';

const textMessage = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const interactiveMessage = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.literal('interactive'),
  interactive: z.union([
    z.object({
      type: z.literal('button_reply'),
      button_reply: z.object({ id: z.string(), title: z.string() }),
    }),
    z.object({
      type: z.literal('list_reply'),
      list_reply: z.object({ id: z.string(), title: z.string() }),
    }),
  ]),
});

/** Any other message type (image, audio, location, …) — recognised but unsupported. */
const otherMessage = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
});

const anyMessage = z.union([textMessage, interactiveMessage, otherMessage]);

const webhookSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                messages: z.array(anyMessage).optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export type WebhookPayload = z.infer<typeof webhookSchema>;

/**
 * Extract every user message from a webhook payload.
 *
 * @returns zero or more normalised messages. Status callbacks and malformed payloads
 *          yield an empty array rather than throwing.
 */
export function parseInbound(payload: unknown): InboundMessage[] {
  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success) return [];

  const out: InboundMessage[] = [];

  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value.metadata?.phone_number_id ?? '';

      for (const raw of change.value.messages ?? []) {
        const timestamp = Number(raw.timestamp);

        if (raw.type === 'text' && 'text' in raw) {
          out.push({
            waMessageId: raw.id,
            from: raw.from,
            text: raw.text.body,
            kind: 'text',
            timestamp,
            phoneNumberId,
          });
          continue;
        }

        if (raw.type === 'interactive' && 'interactive' in raw) {
          const i = raw.interactive;
          const reply = i.type === 'button_reply' ? i.button_reply : i.list_reply;
          out.push({
            waMessageId: raw.id,
            from: raw.from,
            text: reply.title,
            replyId: reply.id,
            kind: 'interactive',
            timestamp,
            phoneNumberId,
          });
          continue;
        }

        // Image, audio, document, location, sticker, … Recognised so the handler can
        // reply "I can only read text messages" rather than silently ignoring a mother
        // who sent a photo of her baby.
        out.push({
          waMessageId: raw.id,
          from: raw.from,
          text: '',
          kind: 'unsupported',
          timestamp,
          phoneNumberId,
        });
      }
    }
  }

  return out;
}

/** True when the payload is a status callback rather than user input. */
export function isStatusCallback(payload: unknown): boolean {
  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success) return false;
  const entries = parsed.data.entry ?? [];
  if (entries.length === 0) return false;
  return entries.every((e) =>
    (e.changes ?? []).every((c) => (c.value.messages ?? []).length === 0),
  );
}
