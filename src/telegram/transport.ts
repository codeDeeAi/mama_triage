/**
 * Telegram transport.
 *
 * Implements the same `MessageTransport` contract as the WhatsApp path, so the
 * orchestrator, the safety layer and the renderer are unchanged. Adding this channel
 * required no edit to any of them — which is the return on having built the abstraction
 * before it was strictly needed.
 */

import type { MessageTransport, TemplateMessage, TransportCapabilities } from '../whatsapp/transport';
import type { ReplyButton } from '../whatsapp/types';
import { findTemplate, renderTemplate, type TemplateKey } from '../whatsapp/templates';
import type { Language } from '../types';
import type { TelegramClient } from './client';

/** Resolve a Meta template name back to its definition. */
function TEMPLATE_BY_NAME(metaName: string): { key: TemplateKey; language: Language } {
  for (const key of ['welcome', 'followup'] as const) {
    for (const language of ['en', 'pcm'] as const) {
      if (findTemplate(key, language).metaName === metaName) return { key, language };
    }
  }
  throw new Error(`unknown template "${metaName}"`);
}

export class TelegramTransport implements MessageTransport {
  readonly capabilities: TransportCapabilities = {
    inbound: true,
    // No template system at all: every outbound message is free text.
    freeTextOutbound: true,
    // Inline keyboards give the same semantics as WhatsApp reply buttons — the tap
    // returns an identifier rather than the visible label.
    interactiveButtons: true,
    provider: 'telegram',
  };

  constructor(private readonly client: TelegramClient) {}

  async sendText(to: string, body: string): Promise<void> {
    await this.client.sendMessage(to, body);
  }

  async sendTyping(to: string): Promise<void> {
    await this.client.sendTyping(to);
  }

  async sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void> {
    await this.client.sendWithButtons(
      to,
      body,
      options.map((o) => ({ text: o.title, callbackData: o.id })),
    );
  }

  /**
   * Telegram has no template concept.
   *
   * A bot may message any user who has started it, at any time, with arbitrary text — so
   * the constraint templates exist to satisfy simply does not apply. The message is sent
   * directly with its parameters substituted, and the caller is not left guessing whether
   * anything was delivered.
   */
  async sendTemplate(to: string, msg: TemplateMessage): Promise<void> {
    // `msg.template` is the Meta template NAME here, since Telegram has no codes.
    const def = TEMPLATE_BY_NAME(msg.template);
    await this.client.sendMessage(
      to,
      renderTemplate(def.key, def.language, msg.params),
    );
  }
}
