/**
 * KudiSMS transport.
 *
 * Built against the published API documentation
 * (https://documenter.getpostman.com/view/44181644/2sB2cd3HUd), which documents exactly
 * two WhatsApp endpoints:
 *
 *   POST https://my.kudisms.net/api/whatsapp_custom
 *        token, recipient, phone_number_id, template_code, parameters,
 *        button_parameters, header_parameters
 *
 *   POST https://my.kudisms.net/api/whatsapp
 *        token, recipient, template_code (fixed), parameters      — OTP only
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 *  TWO CONSTRAINTS THAT DECIDE WHETHER THIS PROVIDER CAN HOST A TRIAGE SYSTEM
 *
 *  1. TEMPLATE-ONLY OUTBOUND. Both endpoints take a `template_code` plus a list of
 *     `parameters` substituted into a pre-approved template. There is no message-body
 *     field. A triage assessment generates novel text every turn — the next question the
 *     model chooses to ask, and the advice it writes — so it cannot be expressed as a
 *     fixed template with slots. `freeTextOutbound` is therefore false, and
 *     `assertTransportUsable()` refuses to start.
 *
 *  2. NO DOCUMENTED WHATSAPP INBOUND WEBHOOK. The documentation describes webhooks for
 *     SMS, voice and email, but none for WhatsApp. Inbound is left configurable rather
 *     than assumed: set `inbound: true` ONLY once you have confirmed with KudiSMS that a
 *     WhatsApp inbound webhook exists and you know its payload shape.
 *
 *  If KudiSMS later exposes free-text session messaging, set `freeTextOutbound` and
 *  point `sendTextEndpoint` at it; the rest of this class already works.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

import type { ReplyButton } from './types';
import type { MessageTransport, TransportCapabilities } from './transport';
import { renderOptionsAsText } from './transport';

export interface KudiSmsOptions {
  /** API key from the KudiSMS dashboard. */
  token: string;
  /** Sender WhatsApp Phone Number ID. */
  phoneNumberId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;

  /**
   * Set true only after confirming with KudiSMS that a WhatsApp inbound webhook exists.
   * Defaults to false: assuming inbound that does not exist produces a service that looks
   * healthy while silently discarding every message a mother sends.
   */
  inbound?: boolean;

  /**
   * Set true only if KudiSMS exposes free-text (non-template) WhatsApp session messages,
   * and supply `sendTextEndpoint`. Defaults to false, matching the documented API.
   */
  freeTextOutbound?: boolean;
  /** Endpoint accepting a free-text body, if the account has one. */
  sendTextEndpoint?: string;

  /** Approved template code used when only template sending is available. */
  templateCode?: string;
}

export class KudiSmsError extends Error {
  override readonly name = 'KudiSmsError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class KudiSmsTransport implements MessageTransport {
  readonly capabilities: TransportCapabilities;

  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sendTextEndpoint: string | undefined;
  private readonly templateCode: string | undefined;

  constructor(opts: KudiSmsOptions) {
    this.token = opts.token;
    this.phoneNumberId = opts.phoneNumberId;
    this.baseUrl = opts.baseUrl ?? 'https://my.kudisms.net/api';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sendTextEndpoint = opts.sendTextEndpoint;
    this.templateCode = opts.templateCode;

    this.capabilities = {
      inbound: opts.inbound ?? false,
      freeTextOutbound: opts.freeTextOutbound ?? false,
      // KudiSMS documents `button_parameters` for dynamic URL buttons only — these fill
      // a URL in an approved template, not reply buttons that produce an inbound choice.
      interactiveButtons: false,
      provider: 'kudisms',
    };
  }

  async sendText(to: string, body: string): Promise<void> {
    if (this.capabilities.freeTextOutbound && this.sendTextEndpoint) {
      await this.post(this.sendTextEndpoint, {
        token: this.token,
        recipient: to,
        phone_number_id: this.phoneNumberId,
        message: body,
      });
      return;
    }

    if (!this.templateCode) {
      throw new KudiSmsError(
        'KudiSMS is configured for template-only sending but no templateCode was ' +
          'supplied. Triage replies are novel text and cannot be sent this way — see ' +
          'the constraints documented at the top of src/whatsapp/kudisms.ts.',
      );
    }

    // Best-effort template send: the whole reply becomes a single template parameter.
    // This only works if an approved template is a bare placeholder, and WhatsApp
    // template policy generally does not permit that for freeform content.
    await this.post('/whatsapp_custom', {
      token: this.token,
      recipient: to,
      phone_number_id: this.phoneNumberId,
      template_code: this.templateCode,
      parameters: body.replace(/,/g, ' '), // parameters are comma-separated
    });
  }

  async sendOptions(to: string, body: string, options: readonly ReplyButton[]): Promise<void> {
    // No reply-button support, so the choice is delivered as numbered text and the
    // handler accepts a numeric reply.
    await this.sendText(to, renderOptionsAsText(body, options));
  }

  private async post(path: string, form: Record<string, string>): Promise<void> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new KudiSmsError(`KudiSMS API ${res.status}: ${detail.slice(0, 200)}`, res.status);
    }
  }
}
