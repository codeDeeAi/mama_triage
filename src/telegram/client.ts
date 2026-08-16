/**
 * Telegram Bot API client.
 *
 * Telegram removes both constraints that make KudiSMS unusable and WhatsApp slow to set
 * up: there is no template system (all outbound is free text) and no business
 * verification (a token from @BotFather takes about two minutes). Inline keyboards give
 * the same reply-button semantics the WhatsApp path uses.
 *
 * The one asymmetry worth knowing: a bot cannot message a user who has never started a
 * conversation with it. That is stricter than WhatsApp's 24-hour window in one respect —
 * there is no template escape hatch — and looser in another: once a user has started the
 * bot, it may message them at any time, with no window to keep alive. For a triage system
 * where the mother always initiates, this is simply better.
 */

const TELEGRAM_MAX_TEXT = 4096;
/** Telegram rejects callback_data longer than 64 bytes. */
export const MAX_CALLBACK_DATA = 64;

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface InlineButton {
  text: string;
  /** Returned verbatim in the callback_query when tapped. */
  callbackData: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split a message for Telegram's 4096-character limit.
 *
 * Breaks on paragraph, then line, then word — never mid-word. Triage advice is numbered
 * and ordered, so structure matters more than filling each message.
 */
export function splitForTelegram(body: string, limit = TELEGRAM_MAX_TEXT): string[] {
  if (body.length <= limit) return [body];

  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
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
    for (const word of paragraph.split(' ')) {
      if (current.length + word.length + 1 > limit) flush();
      current += (current ? ' ' : '') + word;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [body.slice(0, limit)];
}

/**
 * Convert the WhatsApp-style `*bold*` used by the renderer into Telegram MarkdownV2.
 *
 * The renderer emits `*EMERGENCY*` because that is WhatsApp's syntax. Telegram's
 * MarkdownV2 uses the same asterisks for bold but requires a long list of other
 * characters to be escaped — an unescaped `.` or `-` makes the whole API call fail, which
 * would silently drop an emergency referral. Escaping everything except the intentional
 * bold markers is the safe reading.
 */
export function toMarkdownV2(body: string): string {
  const RESERVED = /[_[\]()~`>#+\-=|{}.!\\]/g;
  return body
    .split('*')
    .map((segment) => segment.replace(RESERVED, (c) => `\\${c}`))
    .join('*');
}

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private endpoint(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /** Send text, split across messages if needed and sent in order. */
  async sendMessage(chatId: string, body: string): Promise<void> {
    for (const chunk of splitForTelegram(body)) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: toMarkdownV2(chunk),
        parse_mode: 'MarkdownV2',
        // A triage reply should never render a link preview card over the advice.
        link_preview_options: { is_disabled: true },
      });
    }
  }

  /** Send text with tappable inline buttons, one per row for small screens. */
  async sendWithButtons(
    chatId: string,
    body: string,
    buttons: readonly InlineButton[],
  ): Promise<void> {
    for (const b of buttons) {
      if (Buffer.byteLength(b.callbackData, 'utf8') > MAX_CALLBACK_DATA) {
        throw new Error(
          `callback_data "${b.callbackData}" exceeds ${MAX_CALLBACK_DATA} bytes`,
        );
      }
    }

    await this.call('sendMessage', {
      chat_id: chatId,
      text: toMarkdownV2(body),
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: buttons.map((b) => [
          { text: b.text, callback_data: b.callbackData },
        ]),
      },
    });
  }

  /**
   * Acknowledge a button tap.
   *
   * Without this the client shows a loading spinner on the button for up to 30 seconds,
   * which during an assessment reads as the system having hung.
   */
  async answerCallback(callbackQueryId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  /**
   * Publish the command menu.
   *
   * This is what puts the Menu button beside the message box and makes typing "/" offer
   * autocomplete. It is a per-bot setting, not per-chat: registering once at boot applies
   * to every mother, including those who started the bot months ago.
   */
  async setMyCommands(
    commands: ReadonlyArray<{ name: string; description: string }>,
  ): Promise<void> {
    await this.call('setMyCommands', {
      commands: commands.map((c) => ({ command: c.name, description: c.description })),
    });
  }

  /** Register the webhook. `secretToken` is echoed back on every update. */
  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: true });
  }

  /** Bot identity — used at boot to prove the token works. */
  async getMe(): Promise<{ id: number; username: string }> {
    const res = await this.call('getMe', {});
    return res as { id: number; username: string };
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(this.endpoint(method), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: unknown;
          description?: string;
        };

        if (res.ok && json.ok) return json.result;

        // 429 carries retry_after; 5xx is transient. Everything else is a client error
        // that will fail identically on retry.
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new TelegramApiError(
          `Telegram ${method} failed (${res.status}): ${json.description ?? 'unknown'}`,
          res.status,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (err) {
        if (err instanceof TelegramApiError && !err.retryable) throw err;
        lastError = err;
      }

      if (attempt < this.maxRetries) await this.sleep(2 ** attempt * 300);
    }

    throw lastError instanceof Error
      ? lastError
      : new TelegramApiError(`Telegram ${method} failed`, 0, false);
  }
}
