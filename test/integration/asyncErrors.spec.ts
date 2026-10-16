/**
 * A failure inside an async route must produce a 500, not a hung request.
 *
 * Express 4 ignores the promise a handler returns, so without asyncHandler a rejected
 * database call leaves the client waiting until it times out.
 */

import request from 'supertest';
import { createApp, type AppDeps } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

const boom = async (): Promise<never> => {
  throw new Error('database down');
};

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    appSecret: 'secret',
    verifyToken: 'verify',
    events: { async claim() { return true; }, async markProcessed() {}, async markFailed() {} } as never,
    audit: { async record() {} } as never,
    db: { healthy: async () => true } as never,
    queue: new TaskQueue(),
    logger: silentLogger,
    handleMessage: async () => undefined,
    ...overrides,
  });
}

const failingRegister = {
  register: {
    registrations: { createTelegram: boom, createWhatsApp: boom },
    pepper: 'p'.repeat(64),
    availableChannels: ['telegram'],
    telegramBotUsername: 'TestBot',
  } as never,
};

const telegramSignup = {
  displayName: 'Amaka', channel: 'telegram', language: 'en', consent: 'yes',
};

describe('async route failures', () => {
  // Short timeout: a regression shows up as a hang, and this turns it into a failure.
  const timeout = 2000;

  it('/readyz returns 500 JSON when the health check throws', async () => {
    const res = await request(app({ db: { healthy: boom } as never }))
      .get('/readyz').timeout(timeout);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
  });

  it('/register/api returns 500 JSON when the repository throws', async () => {
    const res = await request(app(failingRegister))
      .post('/register/api').send(telegramSignup).timeout(timeout);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
  });

  it('/register form post returns a 500 HTML page when the repository throws', async () => {
    const res = await request(app(failingRegister))
      .post('/register')
      .set('Accept', 'text/html')
      .type('form')
      .send(telegramSignup)
      .timeout(timeout);
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Something went wrong');
  });

  it('/admin/kb/query returns 500 JSON when retrieval throws', async () => {
    const res = await request(app({
      admin: { isProduction: false, retriever: { retrieve: boom } } as never,
    }))
      .post('/admin/kb/query').send({ query: 'fever' }).timeout(timeout);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
  });

  it('/demo/api/message returns 500 JSON when the session lookup throws', async () => {
    const res = await request(app({
      demo: {
        enabled: true,
        makeHandler: () => async () => undefined,
        sessions: { findLatest: boom },
        pepper: 'p'.repeat(64),
        sessionTtlMinutes: 30,
      } as never,
    }))
      .post('/demo/api/message')
      .send({ sessionId: '3f1c2a9e-0b5d-4f7a-9c1e-2d4b6a8c0e1f', text: 'hello' })
      .timeout(timeout);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
  });
});
