import { isStatusCallback, parseInbound } from '../../src/whatsapp/parseInbound';
import { splitMessage, WhatsAppClient, WhatsAppApiError } from '../../src/whatsapp/client';
import { PREFERRED_BUBBLE_LENGTH } from '../../src/whatsapp/types';

function envelope(messages: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'e1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PNID' },
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe('parseInbound', () => {
  it('parses a text message', () => {
    const out = parseInbound(
      envelope([
        { id: 'wamid.1', from: '2348012345678', timestamp: '1700000000', type: 'text', text: { body: 'my baby has fever' } },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      waMessageId: 'wamid.1',
      from: '2348012345678',
      text: 'my baby has fever',
      kind: 'text',
      timestamp: 1700000000,
      phoneNumberId: 'PNID',
    });
  });

  it('parses a button reply, keeping the ID for routing', () => {
    const out = parseInbound(
      envelope([
        {
          id: 'wamid.2',
          from: '2348012345678',
          timestamp: '1700000000',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'PATHWAY_MOTHER', title: 'For me' } },
        },
      ]),
    );
    expect(out[0]).toMatchObject({ replyId: 'PATHWAY_MOTHER', text: 'For me', kind: 'interactive' });
  });

  it('parses a list reply', () => {
    const out = parseInbound(
      envelope([
        {
          id: 'wamid.3',
          from: '2348012345678',
          timestamp: '1700000000',
          type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: 'DOMAIN_FEEDING', title: 'Feeding' } },
        },
      ]),
    );
    expect(out[0]?.replyId).toBe('DOMAIN_FEEDING');
  });

  it('marks unsupported types so the mother can be told, not ignored', () => {
    const out = parseInbound(
      envelope([{ id: 'wamid.4', from: '2348012345678', timestamp: '1700000000', type: 'image' }]),
    );
    expect(out[0]?.kind).toBe('unsupported');
    expect(out[0]?.text).toBe('');
  });

  it('returns every message from a batched delivery', () => {
    const out = parseInbound(
      envelope([
        { id: 'wamid.a', from: '234801', timestamp: '1', type: 'text', text: { body: 'one' } },
        { id: 'wamid.b', from: '234801', timestamp: '2', type: 'text', text: { body: 'two' } },
      ]),
    );
    expect(out.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty entry array', { entry: [] }],
    ['a malformed message', envelope([{ nope: true }])],
  ])('returns an empty array for %s rather than throwing', (_label, payload) => {
    expect(parseInbound(payload)).toEqual([]);
  });

  it('ignores a status callback', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'e1', changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }],
    };
    expect(parseInbound(payload)).toEqual([]);
    expect(isStatusCallback(payload)).toBe(true);
  });

  it('does not classify a real message as a status callback', () => {
    const payload = envelope([
      { id: 'wamid.5', from: '234801', timestamp: '1', type: 'text', text: { body: 'hi' } },
    ]);
    expect(isStatusCallback(payload)).toBe(false);
  });

  it('does not classify malformed input as a status callback', () => {
    expect(isStatusCallback('nonsense')).toBe(false);
    expect(isStatusCallback({ entry: [] })).toBe(false);
  });
});

describe('splitMessage', () => {
  it('leaves a short message intact', () => {
    expect(splitMessage('short message')).toEqual(['short message']);
  });

  it('splits a long message into bubbles under the limit', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some text.`).join('\n\n');
    const chunks = splitMessage(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PREFERRED_BUBBLE_LENGTH);
  });

  it('never splits mid-word', () => {
    const body = 'word '.repeat(400);
    for (const chunk of splitMessage(body)) {
      expect(chunk).not.toMatch(/\bwor$|^ord\b/);
    }
  });

  it('preserves every word across the split', () => {
    const body = Array.from({ length: 200 }, (_, i) => `token${i}`).join(' ');
    const rejoined = splitMessage(body).join(' ');
    for (let i = 0; i < 200; i++) expect(rejoined).toContain(`token${i}`);
  });

  it('handles a single line longer than the limit', () => {
    const chunks = splitMessage('a '.repeat(1000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PREFERRED_BUBBLE_LENGTH);
  });

  it('handles a single word longer than the limit', () => {
    const chunks = splitMessage('x'.repeat(900));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('respects a custom limit', () => {
    for (const c of splitMessage('one two three four five six', 10)) {
      expect(c.length).toBeLessThanOrEqual(10);
    }
  });
});

/** Minimal fetch double. */
function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r!.status >= 200 && r!.status < 300,
      status: r!.status,
      json: async () => r!.body ?? {},
      text: async () => JSON.stringify(r!.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { impl, calls: calls, get callCount() { return calls.length; } };
}

function client(fetchImpl: typeof fetch, maxRetries = 3) {
  return new WhatsAppClient({
    token: 'tok',
    phoneNumberId: 'PNID',
    fetchImpl,
    maxRetries,
    sleep: async () => undefined, // no real backoff delay in tests
  });
}

describe('WhatsAppClient.sendText', () => {
  it('posts to the Graph API with a bearer token', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.OUT' }] } }]);
    const results = await client(f.impl).sendText('2348012345678', 'hello');

    expect(results[0]?.waMessageId).toBe('wamid.OUT');
    expect(f.calls[0]?.url).toContain('/PNID/messages');
    expect((f.calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('sends long bodies as sequential bubbles, preserving order', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.X' }] } }]);
    // Comfortably over PREFERRED_BUBBLE_LENGTH so a split is guaranteed.
    const body = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i} carrying enough text to push this well past one bubble.`,
    ).join('\n\n');
    await client(f.impl).sendText('2348012345678', body);

    expect(f.callCount).toBeGreaterThan(1);
    const sent = f.calls.map((c) => JSON.parse(c.init.body as string).text.body);
    expect(sent[0]).toContain('Paragraph 0');
    expect(sent[sent.length - 1]).toContain('Paragraph 39');
  });
});

describe('WhatsAppClient — retry policy', () => {
  it('retries a 429 and succeeds', async () => {
    const f = fakeFetch([
      { status: 429 },
      { status: 200, body: { messages: [{ id: 'wamid.R' }] } },
    ]);
    const res = await client(f.impl).sendText('234801', 'hi');
    expect(res[0]?.waMessageId).toBe('wamid.R');
    expect(f.callCount).toBe(2);
  });

  it('retries a 500 and succeeds', async () => {
    const f = fakeFetch([
      { status: 503 },
      { status: 200, body: { messages: [{ id: 'wamid.S' }] } },
    ]);
    await client(f.impl).sendText('234801', 'hi');
    expect(f.callCount).toBe(2);
  });

  it('does NOT retry a 400 — the same request would fail again', async () => {
    const f = fakeFetch([{ status: 400, body: { error: 'bad recipient' } }]);
    await expect(client(f.impl).sendText('234801', 'hi')).rejects.toThrow(WhatsAppApiError);
    expect(f.callCount).toBe(1);
  });

  it('gives up after the retry budget', async () => {
    const f = fakeFetch([{ status: 500 }]);
    await expect(client(f.impl, 2).sendText('234801', 'hi')).rejects.toThrow();
    expect(f.callCount).toBe(3); // initial + 2 retries
  });

  it('retries a network-level failure', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.N' }] }), text: async () => '' };
    }) as unknown as typeof fetch;

    const res = await client(impl).sendText('234801', 'hi');
    expect(res[0]?.waMessageId).toBe('wamid.N');
    expect(calls).toBe(2);
  });
});

describe('WhatsAppClient.sendButtons', () => {
  it('sends an interactive payload', async () => {
    const f = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.B' }] } }]);
    await client(f.impl).sendButtons('234801', 'Who is this for?', [
      { id: 'PATHWAY_MOTHER', title: 'For me' },
      { id: 'PATHWAY_BABY', title: 'For my baby' },
    ]);

    const payload = JSON.parse(f.calls[0]!.init.body as string);
    expect(payload.type).toBe('interactive');
    expect(payload.interactive.action.buttons).toHaveLength(2);
    expect(payload.interactive.action.buttons[0].reply.id).toBe('PATHWAY_MOTHER');
  });

  it('rejects more than three buttons before hitting the API', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(
      client(f.impl).sendButtons('234801', 'x', [
        { id: 'a', title: 'A' }, { id: 'b', title: 'B' },
        { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
      ]),
    ).rejects.toThrow(/1 to 3 reply buttons/);
    expect(f.callCount).toBe(0);
  });

  it('rejects zero buttons', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(client(f.impl).sendButtons('234801', 'x', [])).rejects.toThrow();
  });

  it('rejects a button title over 20 characters', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(
      client(f.impl).sendButtons('234801', 'x', [
        { id: 'a', title: 'This title is definitely far too long' },
      ]),
    ).rejects.toThrow(/exceeds 20 characters/);
    expect(f.callCount).toBe(0);
  });
});
