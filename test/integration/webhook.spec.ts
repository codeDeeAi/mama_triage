/**
 * Webhook integration tests.
 *
 * These cover the three properties that make the endpoint safe to expose publicly:
 * signature verification, ACK-before-work, and idempotency against Meta's retries.
 * Dependencies are in-memory fakes so the suite needs no database and no network.
 */

import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createApp } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';
import type { InboundMessage } from '../../src/whatsapp/types';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

/** In-memory stand-in for WebhookEventRepository. */
class FakeEvents {
  readonly claimed = new Set<string>();
  readonly processed: string[] = [];
  readonly failed: string[] = [];

  async claim(id: string): Promise<boolean> {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }
  async markProcessed(id: string): Promise<void> {
    this.processed.push(id);
  }
  async markFailed(id: string): Promise<void> {
    this.failed.push(id);
  }
  async release(id: string): Promise<void> {
    this.claimed.delete(id);
  }
  async purgeOlderThan(): Promise<number> {
    return 0;
  }
}

class FakeAudit {
  readonly events: Array<{ event: string; detail: unknown }> = [];
  async record(event: string, detail: unknown): Promise<void> {
    this.events.push({ event, detail });
  }
  async listForSession(): Promise<[]> {
    return [];
  }
  async countByEvent(): Promise<number> {
    return 0;
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

function textPayload(waMessageId: string, from = '2348012345678', body = 'hello') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PNID123' },
              messages: [
                {
                  id: waMessageId,
                  from,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
}

interface Harness {
  app: express.Express;
  events: FakeEvents;
  audit: FakeAudit;
  queue: TaskQueue;
  handled: InboundMessage[];
}

function harness(handler?: (m: InboundMessage) => Promise<void>): Harness {
  const events = new FakeEvents();
  const audit = new FakeAudit();
  const queue = new TaskQueue({ concurrency: 2, onError: () => undefined });
  const handled: InboundMessage[] = [];

  const app = createApp({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    events: events as never,
    audit: audit as never,
    db: { healthy: async () => true } as never,
    queue,
    logger: silentLogger,
    handleMessage: async (msg) => {
      handled.push(msg);
      if (handler) await handler(msg);
    },
  });

  return { app, events, audit, queue, handled };
}

describe('GET /webhook — subscription handshake', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const { app } = harness();
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'challenge-12345',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-12345');
  });

  it('rejects a wrong verify token', async () => {
    const { app } = harness();
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': 'challenge-12345',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a missing mode', async () => {
    const { app } = harness();
    const res = await request(app)
      .get('/webhook')
      .query({ 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'c' });
    expect(res.status).toBe(403);
  });
});

describe('POST /webhook — signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const { app, handled, queue } = harness();
    const body = JSON.stringify(textPayload('wamid.OK1'));

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    await queue.onIdle();
    expect(handled).toHaveLength(1);
  });

  it('rejects a payload with no signature header', async () => {
    const { app, handled } = harness();
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(textPayload('wamid.NOSIG')));

    expect(res.status).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it('rejects a forged signature', async () => {
    const { app, handled } = harness();
    const body = JSON.stringify(textPayload('wamid.FORGED'));

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
      .send(body);

    expect(res.status).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it('rejects a signature computed over different bytes', async () => {
    // The exact attack the raw-body requirement exists to stop: a valid signature for
    // one payload replayed against a modified one.
    const { app, handled } = harness();
    const original = JSON.stringify(textPayload('wamid.A'));
    const tampered = JSON.stringify(textPayload('wamid.B'));

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(original))
      .send(tampered);

    expect(res.status).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it('rejects a malformed signature header without throwing', async () => {
    const { app } = harness();
    const body = JSON.stringify(textPayload('wamid.BAD'));
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'not-a-signature')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('audits every rejection', async () => {
    const { app, audit } = harness();
    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(textPayload('wamid.X')));

    expect(audit.events.map((e) => e.event)).toContain('WEBHOOK_REJECTED');
  });

  it('rejects a signed body that is not valid JSON', async () => {
    const { app } = harness();
    const body = 'this is not json';
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(400);
  });
});

describe('POST /webhook — ACK before work', () => {
  it('returns 200 without waiting for the handler', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { app, queue, handled } = harness(async () => {
      await blocked; // handler stays pending
    });

    const body = JSON.stringify(textPayload('wamid.SLOW'));
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    // Responded while the handler is still running.
    expect(res.status).toBe(200);

    release();
    await queue.onIdle();
    expect(handled).toHaveLength(1);
  });
});

describe('POST /webhook — idempotency against Meta retries', () => {
  it('processes a duplicated delivery exactly once', async () => {
    const { app, queue, handled } = harness();
    const body = JSON.stringify(textPayload('wamid.RETRY'));
    const sig = sign(body);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sig)
        .send(body);
      expect(res.status).toBe(200); // every retry is still acknowledged
    }

    await queue.onIdle();
    expect(handled).toHaveLength(1); // but the mother is only answered once
  });

  it('processes distinct messages separately', async () => {
    const { app, queue, handled } = harness();

    for (const id of ['wamid.1', 'wamid.2', 'wamid.3']) {
      const body = JSON.stringify(textPayload(id));
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body))
        .send(body);
    }

    await queue.onIdle();
    expect(handled).toHaveLength(3);
  });

  it('marks a message processed on success', async () => {
    const { app, queue, events } = harness();
    const body = JSON.stringify(textPayload('wamid.DONE'));
    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    await queue.onIdle();
    expect(events.processed).toContain('wamid.DONE');
  });

  it('marks a message failed when the handler throws, and still ACKs', async () => {
    const { app, queue, events } = harness(async () => {
      throw new Error('handler blew up');
    });

    const body = JSON.stringify(textPayload('wamid.FAIL'));
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    await queue.onIdle();
    expect(events.failed).toContain('wamid.FAIL');
  });
});

describe('POST /webhook — payload handling', () => {
  it('ignores a status callback carrying no messages', async () => {
    const { app, queue, handled } = harness();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID123' },
                statuses: [{ id: 'wamid.S', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    await queue.onIdle();
    expect(handled).toHaveLength(0);
  });

  it('handles several messages in one delivery', async () => {
    const { app, queue, handled } = harness();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID123' },
                messages: [
                  { id: 'wamid.M1', from: '2348012345678', timestamp: '1700000000', type: 'text', text: { body: 'first' } },
                  { id: 'wamid.M2', from: '2348012345678', timestamp: '1700000001', type: 'text', text: { body: 'second' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    await queue.onIdle();
    expect(handled.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('passes an interactive button reply through with its ID', async () => {
    const { app, queue, handled } = harness();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'e1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID123' },
                messages: [
                  {
                    id: 'wamid.BTN',
                    from: '2348012345678',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'PATHWAY_BABY', title: 'For my baby' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    await queue.onIdle();
    expect(handled[0]?.replyId).toBe('PATHWAY_BABY');
    expect(handled[0]?.kind).toBe('interactive');
  });
});

describe('health endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const { app } = harness();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports readiness when the database is reachable', async () => {
    const { app } = harness();
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('ok');
  });

  it('reports 503 when the database is unreachable', async () => {
    const events = new FakeEvents();
    const app = createApp({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      events: events as never,
      audit: new FakeAudit() as never,
      db: { healthy: async () => false } as never,
      queue: new TaskQueue(),
      logger: silentLogger,
      handleMessage: async () => undefined,
    });

    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('returns 404 for an unknown route', async () => {
    const { app } = harness();
    expect((await request(app).get('/nope')).status).toBe(404);
  });
});
