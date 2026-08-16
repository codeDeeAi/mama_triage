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

/** A pre-approved template send. */
export interface TemplateMessage {
  /**
   * Provider template identifier. Meta uses the template NAME
   * (`mama_triage_welcome_en`); KudiSMS uses a numeric `template_code` issued when the
   * template is approved. Callers pass whichever the configured transport expects, which
   * is why the codes live in config rather than being hard-coded here.
   */
  template: string;
  /** Ordered body parameters substituted into {{1}}, {{2}}, … */
  params: readonly string[];
  /** BCP-47 language tag. Meta requires it; KudiSMS infers it from the template code. */
  language?: string;
}

export interface MessageTransport {
  readonly capabilities: TransportCapabilities;
  sendText(to: string, body: string): Promise<void>;
  /**
   * Send a pre-approved template.
   *
   * Available even when `freeTextOutbound` is false — that is the whole point of a
   * template, and it is how a conversation is opened before the 24-hour session window
   * exists. It cannot carry a triage reply, which is novel text.
   */
  sendTemplate(to: string, msg: TemplateMessage): Promise<void>;
  /**
   * Present a short list of options.
   *
   * Implementations without native buttons must still deliver the choice; see
   * `renderButtonsAsText`.
   */
  sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void>;
  /**
   * Show that a reply is being prepared, if the channel has the concept.
   *
   * An assessment turn costs a retrieval call and a model call — six to eight seconds of
   * nothing, which on a phone is indistinguishable from the bot having stopped. Optional
   * because not every transport can do it, and never load-bearing: a failed indicator
   * must never cost the mother her assessment.
   */
  sendTyping?(to: string): Promise<void>;
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

  async sendTemplate(to: string, msg: TemplateMessage): Promise<void> {
    await this.client.sendTemplate(to, msg.template, msg.params, msg.language ?? 'en');
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

  async sendTemplate(): Promise<void> {
    throw new Error(
      `transport "${this.capabilities.provider}" has no template concept. ` +
        'Templates are a WhatsApp Business API feature; a generic text transport sends ' +
        'the message directly instead.',
    );
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
