/**
 * Messaging transport abstraction.
 *
 * The orchestrator should not know which WhatsApp provider is in use. Meta's Cloud API is
 * the reference implementation, but Nigerian projects often reach WhatsApp through a
 * local CPaaS reseller instead, and those differ in two ways that matter:
 *
 *   1. **Inbound.** Some resellers are send-only (OTPs, templates, notifications). A
 *      triage system is entirely inbound-driven, so a provider without inbound webhooks
 *      cannot host this system at all. `capabilities.inbound` makes that explicit rather
 *      than something discovered after integration work.
 *   2. **Interactive replies.** Meta supports reply buttons; many resellers do not.
 *      Rather than losing the consent and pathway prompts, a transport that cannot render
 *      buttons falls back to numbered text options, and the handler accepts numeric
 *      replies. The conversation degrades in presentation, not in function.
 */

import type { ReplyButton } from './types';
import type { WhatsAppClient } from './client';

export interface TransportCapabilities {
  /** False for send-only providers. Without this the system cannot operate. */
  inbound: boolean;
  /**
   * Whether arbitrary text can be sent.
   *
   * Several CPaaS resellers expose WhatsApp only through pre-approved templates: you
   * supply a `template_code` and a list of parameters, not a message body. That is fine
   * for OTPs and order updates, and fatal for triage — every turn of an assessment is
   * novel text written by the model, and no template can enumerate it in advance.
   */
  freeTextOutbound: boolean;
  /** Native interactive reply buttons. When false, buttons render as numbered text. */
  interactiveButtons: boolean;
  /** Provider name, recorded in logs and in the report's deployment section. */
  provider: string;
}

export interface MessageTransport {
  readonly capabilities: TransportCapabilities;
  sendText(to: string, body: string): Promise<void>;
  /**
   * Present a short list of options.
   *
   * Implementations without native buttons must still deliver the choice; see
   * `renderButtonsAsText`.
   */
  sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void>;
}

/**
 * Render options as numbered text, for transports without interactive messages.
 *
 * The numbering is what the handler's reply matching keys on, so the wording here and the
 * numeric matching in the handler must stay in step.
 */
export function renderOptionsAsText(
  body: string,
  options: readonly ReplyButton[],
): string {
  const lines = [body, ''];
  options.forEach((o, i) => lines.push(`${i + 1}. ${o.title}`));
  lines.push('');
  lines.push(`Reply with a number (1-${options.length}).`);
  return lines.join('\n');
}

/** Meta WhatsApp Business Cloud API — the reference transport. */
export class MetaCloudTransport implements MessageTransport {
  readonly capabilities: TransportCapabilities = {
    inbound: true,
    freeTextOutbound: true,
    interactiveButtons: true,
    provider: 'meta-cloud-api',
  };

  constructor(private readonly client: WhatsAppClient) {}

  async sendText(to: string, body: string): Promise<void> {
    await this.client.sendText(to, body);
  }

  async sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void> {
    await this.client.sendButtons(to, body, options);
  }
}

/**
 * Adapter for a text-only provider (a CPaaS reseller without interactive messages).
 *
 * Deliberately abstract: it takes a `send` function rather than implementing any specific
 * provider's HTTP API, because those differ and guessing at one would produce code that
 * looks finished but has never spoken to the service.
 *
 * To use a reseller, supply `send` and confirm `inbound` honestly — if the provider has
 * no inbound webhook, set it to false and the service will refuse to start rather than
 * appear to work while silently ignoring every mother who writes in.
 */
export class TextOnlyTransport implements MessageTransport {
  readonly capabilities: TransportCapabilities;

  constructor(
    private readonly send: (to: string, body: string) => Promise<void>,
    opts: { provider: string; inbound: boolean },
  ) {
    this.capabilities = {
      inbound: opts.inbound,
      freeTextOutbound: true,
      interactiveButtons: false,
      provider: opts.provider,
    };
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.send(to, body);
  }

  async sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void> {
    await this.send(to, renderOptionsAsText(body, options));
  }
}

/**
 * Refuse to start on a transport that cannot receive messages.
 *
 * A send-only provider can deliver a reply but never hear a symptom. Starting anyway
 * would present a working-looking service that silently drops every inbound message —
 * the worst possible failure for a triage tool.
 */
export function assertTransportUsable(t: MessageTransport): void {
  if (!t.capabilities.inbound) {
    throw new Error(
      `transport "${t.capabilities.provider}" does not support inbound messages. ` +
        `A triage system is inbound-driven: without a webhook for incoming messages it ` +
        `cannot receive a single symptom description. Use a provider with two-way ` +
        `messaging (e.g. the Meta WhatsApp Business Cloud API).`,
    );
  }
  if (!t.capabilities.freeTextOutbound) {
    throw new Error(
      `transport "${t.capabilities.provider}" can only send pre-approved templates. ` +
        `Every turn of a triage assessment is novel text — the question the model asks ` +
        `next, and the advice it gives — so no fixed set of templates can carry it. ` +
        `Use a provider that permits free-text session messages.`,
    );
  }
}
