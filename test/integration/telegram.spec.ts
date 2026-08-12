/**
 * Telegram webhook integration.
 *
 * Proves the channel is authenticated, idempotent, and drives the same handler the
 * WhatsApp path does — the point of the transport abstraction.
 */

import request from 'supertest';
import { createApp } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';
import type { ParsedUpdate } from '../../src/telegram/parseUpdate';

const SECRET = 'telegram-webhook-secret';

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

class FakeEvents {
  readonly claimed = new Set<string>();
  readonly processed: string[] = [];
  readonly failed: string[] = [];
  async claim(id: string) { if (this.claimed.has(id)) return false; this.claimed.add(id); return true; }
  async markProcessed(id: string) { this.processed.push(id); }
  async markFailed(id: string) { this.failed.push(id); }
}

function harness(handler?: (m: ParsedUpdate) => Promise<void>) {
  const events = new FakeEvents();
  const queue = new TaskQueue({ concurrency: 2, onError: () => undefined });
  const handled: ParsedUpdate[] = [];
  const acked: string[] = [];

  const app = createApp({
    appSecret: '',
    verifyToken: '',
    whatsappEnabled: false,
    events: events as never,
    audit: { async record() {} } as never,
    db: { healthy: async () => true } as never,
    queue,
    logger: silentLogger,
    handleMessage: async () => undefined,
    telegram: {
      secretToken: SECRET,
      client: { async answerCallback(id: string) { acked.push(id); } } as never,
      handleMessage: async (m) => { handled.push(m); if (handler) await handler(m); },
    },
  });

  return { app, events, queue, handled, acked };
}

const textUpdate = (updateId: number, text: string) => ({
  update_id: updateId,
  message: { message_id: updateId, from: { id: 555 }, chat: { id: 555 }, date: 1700000000, text },
});

describe('POST /telegram/webhook — authentication', () => {
  it('accepts an update with the correct secret token', async () => {
    const h = harness();
    const res = await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send(textUpdate(1, 'hello'));

    expect(res.status).toBe(200);
    await h.queue.onIdle();
    expect(h.handled).toHaveLength(1);
  });

  it('rejects a missing secret token', async () => {
    const h = harness();
    const res = await request(h.app).post('/telegram/webhook').send(textUpdate(2, 'hello'));
    expect(res.status).toBe(401);
    expect(h.handled).toHaveLength(0);
  });

  it('rejects a wrong secret token', async () => {
    const h = harness();
    const res = await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send(textUpdate(3, 'hello'));
    expect(res.status).toBe(401);
    expect(h.handled).toHaveLength(0);
  });

  it('is not mounted at all when Telegram is not configured', async () => {
    const app = createApp({
      appSecret: 's', verifyToken: 'v', whatsappEnabled: true,
      events: new FakeEvents() as never,
      audit: { async record() {} } as never,
      db: { healthy: async () => true } as never,
      queue: new TaskQueue(),
      logger: silentLogger,
      handleMessage: async () => undefined,
    });
    const res = await request(app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send(textUpdate(4, 'hello'));
    expect(res.status).toBe(404);
  });
});

describe('POST /telegram/webhook — delivery semantics', () => {
  it('ACKs before running the handler', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const h = harness(async () => { await blocked; });

    const res = await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send(textUpdate(5, 'hello'));

    expect(res.status).toBe(200);
    release();
    await h.queue.onIdle();
    expect(h.handled).toHaveLength(1);
  });

  it('processes a redelivered update exactly once', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const res = await request(h.app)
        .post('/telegram/webhook')
        .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
        .send(textUpdate(6, 'hello'));
      expect(res.status).toBe(200);
    }
    await h.queue.onIdle();
    expect(h.handled).toHaveLength(1);
  });

  it('acknowledges a button tap so the client stops showing a spinner', async () => {
    const h = harness();
    await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send({
        update_id: 7,
        callback_query: {
          id: 'cbq-99', from: { id: 555 }, data: 'CONSENT_ACCEPT',
          message: { message_id: 1, chat: { id: 555 } },
        },
      });

    await h.queue.onIdle();
    expect(h.acked).toContain('cbq-99');
    expect(h.handled[0]?.replyId).toBe('CONSENT_ACCEPT');
  });

  it('ignores an update carrying nothing actionable', async () => {
    const h = harness();
    const res = await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send({ update_id: 8, my_chat_member: { chat: { id: 1 } } });

    expect(res.status).toBe(200);
    await h.queue.onIdle();
    expect(h.handled).toHaveLength(0);
  });

  it('marks a failed update and still ACKs', async () => {
    const h = harness(async () => { throw new Error('handler failed'); });
    const res = await request(h.app)
      .post('/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send(textUpdate(9, 'hello'));

    expect(res.status).toBe(200);
    await h.queue.onIdle();
    expect(h.events.failed).toContain('tg.9');
  });
});
