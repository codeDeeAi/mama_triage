/**
 * WhatsApp Business Cloud API client (outbound).
 *
 * Wraps the Graph API so the rest of the system never constructs a Meta request directly.
 * Encodes the platform constraints that are easy to discover at demo time and hard to
 * debug: body length, button count and title length, retry policy.
 */

import {
  MAX_BUTTONS,
  MAX_BUTTON_TITLE,
  MAX_TEXT_LENGTH,
  PREFERRED_BUBBLE_LENGTH,
  type ReplyButton,
} from './types';

export interface WhatsAppClientOptions {
  token: string;
  phoneNumberId: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Injectable so retry tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SendResult {
  waMessageId: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WhatsAppApiError extends Error {
  override readonly name = 'WhatsAppApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Split a long body into WhatsApp-sized chunks.
 *
 * Splits on paragraph, then line, then hard-wraps — never mid-word. Triage advice is
 * numbered and ordered, so preserving structure matters more than filling each bubble.
 */
export function splitMessage(
  body: string,
  limit: number = PREFERRED_BUBBLE_LENGTH,
): string[] {
  if (body.length <= limit) return [body];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of body.split('\n\n')) {
    if (current.length + paragraph.length + 2 <= limit) {
      current += (current ? '\n\n' : '') + paragraph;
      continue;
    }
    flush();

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    // Paragraph alone exceeds the limit: break on lines, then on words.
    for (const line of paragraph.split('\n')) {
      if (current.length + line.length + 1 <= limit) {
        current += (current ? '\n' : '') + line;
        continue;
      }
      flush();

      if (line.length <= limit) {
        current = line;
        continue;
      }

      for (const word of line.split(' ')) {
        if (current.length + word.length + 1 > limit) flush();
        current += (current ? ' ' : '') + word;
      }
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [body.slice(0, limit)];
}

export class WhatsAppClient {
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: WhatsAppClientOptions) {
    this.token = opts.token;
    this.phoneNumberId = opts.phoneNumberId;
    this.baseUrl = opts.baseUrl ?? 'https://graph.facebook.com';
    this.apiVersion = opts.apiVersion ?? 'v21.0';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get endpoint(): string {
    return `${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  /**
   * Send one or more text bubbles.
   *
   * Long bodies are split and sent **sequentially**, because WhatsApp does not guarantee
   * ordering for concurrent sends and a triage message whose steps arrive out of order is
   * worse than useless.
   */
  async sendText(to: string, body: string): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const chunk of splitMessage(body)) {
      results.push(
        await this.post({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: chunk.slice(0, MAX_TEXT_LENGTH) },
        }),
      );
    }
    return results;
  }

  /** Send a message with up to three reply buttons. */
  async sendButtons(
    to: string,
    body: string,
    buttons: readonly ReplyButton[],
  ): Promise<SendResult> {
    if (buttons.length === 0 || buttons.length > MAX_BUTTONS) {
      throw new Error(`WhatsApp allows 1 to ${MAX_BUTTONS} reply buttons, got ${buttons.length}`);
    }
    for (const b of buttons) {
      if (b.title.length > MAX_BUTTON_TITLE) {
        throw new Error(
          `button title "${b.title}" exceeds ${MAX_BUTTON_TITLE} characters`,
        );
      }
    }

    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  /**
   * Send a pre-approved template.
   *
   * Templates are the only message type permitted outside the 24-hour customer service
   * window, so this is how a conversation is opened with a mother who has registered but
   * not yet written in.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    params: readonly string[],
    language = 'en',
  ): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        ...(params.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  parameters: params.map((text) => ({ type: 'text', text })),
                },
              ],
            }
          : {}),
      },
    });
  }

  private async post(payload: unknown): Promise<SendResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const json = (await res.json()) as { messages?: Array<{ id?: string }> };
          return { waMessageId: json.messages?.[0]?.id ?? null };
        }

        // 4xx other than 429 is a client error: the same request will fail again.
        const retryable = res.status === 429 || res.status >= 500;
        const detail = await res.text().catch(() => '');
        lastError = new WhatsAppApiError(
          `WhatsApp API ${res.status}: ${detail.slice(0, 200)}`,
          res.status,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (err) {
        if (err instanceof WhatsAppApiError && !err.retryable) throw err;
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 250);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`WhatsApp send failed: ${String(lastError)}`);
  }
}
