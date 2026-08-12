/**
 * WhatsApp Business Cloud API payload shapes.
 *
 * Only the fields this system actually reads are modelled. The webhook envelope is
 * treated as untrusted input and validated with Zod before use (see parseInbound.ts):
 * a payload that reaches the handler has been proved to have the shape claimed here.
 */

/** A normalised inbound message, after parsing and validation. */
export interface InboundMessage {
  /**
   * Which channel this arrived on. Determines how the sender's identity is hashed, and
   * keeps sessions from two channels from ever colliding.
   */
  channel: 'whatsapp' | 'telegram';
  /** Meta's message ID (`wamid.…`). The idempotency key. */
  waMessageId: string;
  /** Sender's phone number in E.164 without `+`. Hashed immediately; never persisted. */
  from: string;
  /** Message text. For a button/list reply this is the reply title. */
  text: string;
  /** Set when the user tapped an interactive reply, e.g. `PATHWAY_MOTHER`. */
  replyId?: string;
  kind: 'text' | 'interactive' | 'unsupported';
  /** Meta's timestamp, seconds since epoch. */
  timestamp: number;
  /** Business phone number ID the message arrived on. */
  phoneNumberId: string;
}

/** An outbound interactive reply button. Cloud API allows at most 3, titles ≤ 20 chars. */
export interface ReplyButton {
  id: string;
  title: string;
}

export const MAX_BUTTONS = 3;
export const MAX_BUTTON_TITLE = 20;
/** Cloud API hard limit on a text body. */
export const MAX_TEXT_LENGTH = 4096;
/** Self-imposed limit per bubble for readability on a small screen. */
export const PREFERRED_BUBBLE_LENGTH = 600;
