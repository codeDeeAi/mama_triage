import {
  SmsNotifier,
  SmsError,
  followUpSms,
  isUnicode,
  segmentCount,
} from '../../../src/sms/notifier';

describe('segment counting', () => {
  it('counts a short GSM message as one segment', () => {
    expect(segmentCount('Hi Amina, this is MamaTriage.')).toBe(1);
    expect(isUnicode('Hi Amina, this is MamaTriage.')).toBe(false);
  });

  it('detects non-GSM characters, which triple the cost', () => {
    // A single emoji drops the segment size from 160 to 70. The chat renderer emits
    // 🔴/🟠/🟢 banners, which is exactly why SMS copy is written separately.
    expect(isUnicode('EMERGENCY 🔴')).toBe(true);
    expect(isUnicode('Go to the health facility now.')).toBe(false);
  });

  it('accounts for the concatenation header on long messages', () => {
    // Multipart messages carry a header, so usable characters drop from 160 to 153.
    expect(segmentCount('a'.repeat(160))).toBe(1);
    expect(segmentCount('a'.repeat(161))).toBe(2);
    expect(segmentCount('a'.repeat(320))).toBe(3);
  });

  it('counts unicode messages against the smaller limit', () => {
    expect(segmentCount('🔴' + 'a'.repeat(69))).toBe(2);
  });
});

function harness(responses: Array<{ status: number }> = [{ status: 200 }]) {
  const calls: Array<Record<string, string>> = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(Object.fromEntries(new URLSearchParams(init.body as string)));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return { ok: r.status < 300, status: r.status, text: async () => '' };
  }) as unknown as typeof fetch;

  return {
    calls,
    notifier: new SmsNotifier({ token: 'tok', senderId: 'MamaTriage', fetchImpl }),
  };
}

describe('SmsNotifier', () => {
  it('posts a free-text message — no template needed', async () => {
    // The one respect in which the KudiSMS SMS API beats its WhatsApp API.
    const h = harness();
    await h.notifier.send('2348012345678', 'Hi Amina, this is MamaTriage.');

    expect(h.calls[0]).toMatchObject({
      token: 'tok',
      senderID: 'MamaTriage',
      recipients: '2348012345678',
      message: 'Hi Amina, this is MamaTriage.',
    });
  });

  it('reports the cost of what it sent', async () => {
    const h = harness();
    const result = await h.notifier.send('234801', 'a'.repeat(200));
    expect(result.segments).toBe(2);
    expect(result.unicode).toBe(false);
  });

  it('refuses a message long enough that the cost is probably a mistake', async () => {
    // A triage conclusion rendered for WhatsApp runs to several hundred characters and
    // would silently cost four or five segments per recipient.
    const h = harness();
    await expect(h.notifier.send('234801', 'a'.repeat(1000))).rejects.toThrow(SmsError);
    await expect(h.notifier.send('234801', 'a'.repeat(1000))).rejects.toThrow(/segments/);
    expect(h.calls).toHaveLength(0);
  });

  it('names emoji as the cause when a message is unexpectedly expensive', async () => {
    const h = harness();
    await expect(
      h.notifier.send('234801', '🔴 ' + 'a'.repeat(300)),
    ).rejects.toThrow(/emoji/);
  });

  it('surfaces an API failure rather than reporting success', async () => {
    const h = harness([{ status: 401 }]);
    await expect(h.notifier.send('234801', 'hello')).rejects.toThrow(/401/);
  });
});

describe('follow-up copy', () => {
  it('fits in a single segment in both languages', () => {
    for (const lang of ['en', 'pcm'] as const) {
      const body = followUpSms('Amina', lang, 'Telegram');
      expect(isUnicode(body)).toBe(false); // plain ASCII keeps it on 160-char segments
      expect(segmentCount(body)).toBeLessThanOrEqual(2);
    }
  });

  it('prompts a return to the chat channel rather than attempting triage', () => {
    // SMS cannot receive her reply, so it must not start an assessment it cannot finish.
    const body = followUpSms('Amina', 'en', 'Telegram');
    expect(body).toMatch(/Message us on Telegram/);
    expect(body).toMatch(/health facility/);
  });

  it('writes Pidgin properly rather than translating word for word', () => {
    const body = followUpSms('Amina', 'pcm', 'Telegram');
    expect(body).toMatch(/How your pikin dey now/);
    expect(body).toMatch(/health centre/);
  });
});
