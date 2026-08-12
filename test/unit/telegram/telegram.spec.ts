import { parseUpdate, isIgnorable } from '../../../src/telegram/parseUpdate';
import {
  splitForTelegram,
  toMarkdownV2,
  TelegramClient,
  TelegramApiError,
  MAX_CALLBACK_DATA,
} from '../../../src/telegram/client';
import { TelegramTransport } from '../../../src/telegram/transport';

describe('parseUpdate — text messages', () => {
  it('parses a plain message', () => {
    const m = parseUpdate({
      update_id: 42,
      message: {
        message_id: 7,
        from: { id: 111, first_name: 'Amina', language_code: 'en' },
        chat: { id: 111 },
        date: 1700000000,
        text: 'my baby is not feeding',
      },
    });

    expect(m).toMatchObject({
      waMessageId: 'tg.42',
      from: '111',
      text: 'my baby is not feeding',
      kind: 'text',
      timestamp: 1700000000,
      clientLanguage: 'en',
    });
  });

  it('normalises a bare /start into a greeting', () => {
    // "/start" is a Telegram command, not a symptom. Feeding it to the safety scan as
    // free text would be noise.
    const m = parseUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: 5 }, text: '/start' },
    });
    expect(m?.text).toBe('hello');
    expect(m?.startPayload).toBeUndefined();
  });

  it('extracts a deep-link payload from /start', () => {
    // t.me/Bot?start=<payload> is how a web registration is linked to a chat without
    // ever asking for a phone number.
    const m = parseUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: 5 }, text: '/start reg_abc123' },
    });
    expect(m?.startPayload).toBe('reg_abc123');
    expect(m?.text).toBe('hello');
  });

  it('marks non-text messages unsupported rather than dropping them', () => {
    const m = parseUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: 5 }, photo: [{ file_id: 'x' }] },
    });
    expect(m?.kind).toBe('unsupported');
  });
});

describe('parseUpdate — button taps', () => {
  it('parses a callback query, keeping the ID for routing', () => {
    const m = parseUpdate({
      update_id: 9,
      callback_query: {
        id: 'cbq-1',
        from: { id: 222, language_code: 'en' },
        data: 'CONSENT_ACCEPT',
        message: { message_id: 4, chat: { id: 222 }, date: 1700000001 },
      },
    });

    expect(m).toMatchObject({
      from: '222',
      replyId: 'CONSENT_ACCEPT',
      kind: 'interactive',
      callbackQueryId: 'cbq-1',
    });
  });

  it('falls back to the sender id when the message is absent', () => {
    const m = parseUpdate({
      update_id: 10,
      callback_query: { id: 'cbq-2', from: { id: 333 }, data: 'PATHWAY_BABY' },
    });
    expect(m?.from).toBe('333');
  });
});

describe('parseUpdate — ignorable input', () => {
  it.each([
    ['null', null],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an update with nothing actionable', { update_id: 1 }],
    ['an edited message', { update_id: 1, edited_message: { message_id: 1, chat: { id: 1 }, text: 'x' } }],
  ])('ignores %s', (_label, payload) => {
    expect(parseUpdate(payload)).toBeNull();
    expect(isIgnorable(payload)).toBe(true);
  });
});

describe('splitForTelegram', () => {
  it('leaves a short message intact', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
  });

  it('splits past the 4096 limit without breaking words', () => {
    const body = 'word '.repeat(2000);
    const chunks = splitForTelegram(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join(' ')).not.toMatch(/wor$|^ord/);
  });

  it('preserves every token', () => {
    const body = Array.from({ length: 1500 }, (_, i) => `t${i}`).join(' ');
    const rejoined = splitForTelegram(body, 200).join(' ');
    for (let i = 0; i < 1500; i++) expect(rejoined).toContain(`t${i}`);
  });
});

describe('toMarkdownV2', () => {
  it('escapes the characters that would break the API call', () => {
    // An unescaped "." or "-" makes sendMessage fail outright, which would silently drop
    // an emergency referral.
    const out = toMarkdownV2('Go now. Call someone (urgent) - do not wait!');
    expect(out).toContain('\\.');
    expect(out).toContain('\\-');
    expect(out).toContain('\\(');
    expect(out).toContain('\\!');
  });

  it('preserves intentional bold markers from the renderer', () => {
    const out = toMarkdownV2('🔴 *EMERGENCY — GO NOW*');
    expect(out.match(/\*/g)).toHaveLength(2);
    expect(out).toContain('EMERGENCY');
  });

  it('round-trips a full emergency message without losing the referral', () => {
    const body = '🔴 *EMERGENCY*\n\nGo to the nearest health facility now.';
    const out = toMarkdownV2(body);
    expect(out).toContain('nearest health facility now');
  });
});

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? { ok: r.status < 300, result: {} },
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new TelegramClient({
    token: '123:ABC',
    fetchImpl,
    maxRetries,
    sleep: async () => undefined,
  });
}

describe('TelegramClient', () => {
  it('posts to the bot endpoint', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: {} } }]);
    await client(f.impl).sendMessage('111', 'hello');
    expect(f.calls[0]?.url).toContain('/bot123:ABC/sendMessage');
    expect(f.calls[0]?.body.chat_id).toBe('111');
  });

  it('disables link previews so a URL cannot cover the advice', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: {} } }]);
    await client(f.impl).sendMessage('111', 'see https://example.com');
    expect(f.calls[0]?.body.link_preview_options).toEqual({ is_disabled: true });
  });

  it('sends inline buttons one per row', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: {} } }]);
    await client(f.impl).sendWithButtons('111', 'Choose', [
      { text: 'Yes, continue', callbackData: 'CONSENT_ACCEPT' },
      { text: 'No, thank you', callbackData: 'CONSENT_DECLINE' },
    ]);

    const markup = f.calls[0]?.body.reply_markup as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]).toHaveLength(1);
  });

  it('rejects callback data over the 64-byte limit before calling the API', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(
      client(f.impl).sendWithButtons('111', 'x', [
        { text: 'x', callbackData: 'y'.repeat(MAX_CALLBACK_DATA + 1) },
      ]),
    ).rejects.toThrow(/exceeds 64 bytes/);
    expect(f.calls).toHaveLength(0);
  });

  it('retries a 429 and succeeds', async () => {
    const f = fakeFetch([
      { status: 429, body: { ok: false, description: 'Too Many Requests' } },
      { status: 200, body: { ok: true, result: {} } },
    ]);
    await client(f.impl).sendMessage('111', 'hi');
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const f = fakeFetch([{ status: 400, body: { ok: false, description: 'Bad Request' } }]);
    await expect(client(f.impl).sendMessage('111', 'hi')).rejects.toThrow(TelegramApiError);
    expect(f.calls).toHaveLength(1);
  });

  it('registers the webhook with a secret token and restricted update types', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: true } }]);
    await client(f.impl).setWebhook('https://example.com/telegram/webhook', 'sekrit');
    expect(f.calls[0]?.body).toMatchObject({
      url: 'https://example.com/telegram/webhook',
      secret_token: 'sekrit',
      allowed_updates: ['message', 'callback_query'],
    });
  });
});

describe('TelegramTransport', () => {
  it('declares the capabilities that make it viable', () => {
    // The contrast that matters: KudiSMS fails both of the first two.
    const t = new TelegramTransport({} as never);
    expect(t.capabilities).toEqual({
      inbound: true,
      freeTextOutbound: true,
      interactiveButtons: true,
      provider: 'telegram',
    });
  });

  it('maps reply options onto inline buttons, preserving the ID', async () => {
    const calls: Array<{ body: string; buttons: unknown }> = [];
    const t = new TelegramTransport({
      async sendMessage(_to: string, body: string) { calls.push({ body, buttons: null }); },
      async sendWithButtons(_to: string, body: string, buttons: unknown) {
        calls.push({ body, buttons });
      },
    } as never);

    await t.sendOptions('111', 'Who is this for?', [
      { id: 'PATHWAY_MOTHER', title: 'For me (mother)' },
    ]);

    expect(calls[0]?.buttons).toEqual([
      { text: 'For me (mother)', callbackData: 'PATHWAY_MOTHER' },
    ]);
  });

  it('renders the approved template copy rather than inventing its own', async () => {
    // A mother must read the same words whichever channel she registered on, or the two
    // arms of the evaluation are not comparable.
    const sent: string[] = [];
    const t = new TelegramTransport({
      async sendMessage(_to: string, body: string) { sent.push(body); },
    } as never);

    await t.sendTemplate('111', {
      template: 'mama_triage_welcome_en',
      params: ['Amina', 'the MIVA maternal health study'],
    });

    expect(sent[0]).toContain('Hi Amina, you are now registered with the MIVA maternal health study');
    expect(sent[0]).toContain('research prototype, not a doctor');
    expect(sent[0]).toContain('nearest health facility');
  });

  it('renders the Pidgin template in Pidgin', async () => {
    const sent: string[] = [];
    const t = new TelegramTransport({
      async sendMessage(_to: string, body: string) { sent.push(body); },
    } as never);

    await t.sendTemplate('111', {
      template: 'mama_triage_welcome_pcm',
      params: ['Amina', 'di MIVA study'],
    });

    expect(sent[0]).toContain('you don register');
    expect(sent[0]).toContain('health centre wey dey near you');
  });

  it('rejects an unknown template name', async () => {
    const t = new TelegramTransport({ async sendMessage() {} } as never);
    await expect(
      t.sendTemplate('111', { template: 'not_a_template', params: [] }),
    ).rejects.toThrow(/unknown template/);
  });
});
