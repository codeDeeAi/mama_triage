/**
 * Registration integration.
 *
 * The property under test is data minimisation: a Telegram registration must store no
 * contact identifier at all, and a phone number must be collected only when WhatsApp is
 * chosen.
 */

import request from 'supertest';
import { createApp } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';
import { createDb, type Db } from '../../src/db/pool';
import { RegistrationRepository } from '../../src/db/repositories/registration.repo';
import { hashIdentity } from '../../src/privacy/hashPhone';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';
const PEPPER = 'register-test-pepper'.padEnd(64, 'q');

let db: Db;
let available = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL, 4);
  available = await db.healthy();
});
afterAll(async () => { if (db) await db.close(); });

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => { if (!available) return; await fn(); });

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

function app(channels: Array<'whatsapp' | 'telegram'>, whatsappTransport?: unknown) {
  return createApp({
    appSecret: 's', verifyToken: 'v', whatsappEnabled: false,
    events: { async claim() { return true; }, async markProcessed() {}, async markFailed() {} } as never,
    audit: { async record() {} } as never,
    db: { healthy: async () => true } as never,
    queue: new TaskQueue(),
    logger: silentLogger,
    handleMessage: async () => undefined,
    register: {
      registrations: new RegistrationRepository(db),
      pepper: PEPPER,
      availableChannels: channels,
      telegramBotUsername: 'Nne_m_BOT',
      studyName: 'the MIVA maternal health study',
      ...(whatsappTransport ? { whatsappTransport: whatsappTransport as never } : {}),
    },
  });
}

describe('GET /register/api/channels', () => {
  maybe('reports only the channels this deployment offers', async () => {
    const res = await request(app(['telegram'])).get('/register/api/channels');
    expect(res.body.channels).toEqual(['telegram']);
    expect(res.body.telegramBotUsername).toBe('Nne_m_BOT');
  });
});

describe('Telegram registration — no identifier collected', () => {
  maybe('registers with a name alone and returns a deep link', async () => {
    const res = await request(app(['telegram']))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'telegram' });

    expect(res.status).toBe(200);
    expect(res.body.deepLink).toMatch(/^https:\/\/t\.me\/Nne_m_BOT\?start=/);
  });

  maybe('stores no contact identifier until she opens the bot', async () => {
    // The privacy property that makes Telegram the better channel: at this point the
    // database holds a display name and a random token, and nothing that could reach or
    // identify her.
    const res = await request(app(['telegram']))
      .post('/register/api')
      .send({ displayName: 'Ngozi', channel: 'telegram' });

    const row = await db.one<{ identity_hash: string | null; link_token: string }>(
      `SELECT identity_hash, link_token FROM registrations WHERE id = $1`,
      [res.body.registrationId],
    );
    expect(row?.identity_hash).toBeNull();
    expect(row?.link_token).toBeTruthy();
  });

  maybe('refuses a phone number on the Telegram path', async () => {
    // Enforced server-side rather than trusted to the form, so the privacy property
    // cannot be defeated by a crafted request.
    const res = await request(app(['telegram']))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'telegram', phone: '08012345678' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must not include a phone number/i);
  });

  maybe('binds the chat when she sends /start with the token, once only', async () => {
    const repo = new RegistrationRepository(db);
    const reg = await repo.createTelegram('Chiamaka');
    const chatHash = hashIdentity('telegram', '900555111', PEPPER);

    const linked = await repo.linkTelegram(reg.link_token as string, chatHash);
    expect(linked?.identity_hash).toBe(chatHash);

    // Single use: a forwarded link cannot attach a second chat.
    const again = await repo.linkTelegram(reg.link_token as string, 'other'.padEnd(64, 'x'));
    expect(again).toBeNull();
  });
});

describe('WhatsApp registration — phone required, hashed before storage', () => {
  maybe('requires a phone number', async () => {
    const res = await request(app(['whatsapp']))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'whatsapp' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/phone number is needed/i);
  });

  maybe('never stores the number in readable form', async () => {
    const phone = '08099887766';
    const res = await request(app(['whatsapp']))
      .post('/register/api')
      .send({ displayName: 'Halima', channel: 'whatsapp', phone });

    expect(res.status).toBe(200);

    const row = await db.one<{ identity_hash: string }>(
      `SELECT identity_hash FROM registrations WHERE id = $1`,
      [res.body.registrationId],
    );
    expect(row?.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.identity_hash).not.toContain('8099887766');
    expect(row?.identity_hash).toBe(hashIdentity('whatsapp', phone, PEPPER));
  });

  maybe('sends the approved welcome template', async () => {
    const sent: Array<{ template: string; params: readonly string[] }> = [];
    const transport = {
      capabilities: { provider: 'meta-cloud-api' },
      async sendTemplate(_to: string, msg: { template: string; params: readonly string[] }) {
        sent.push(msg);
      },
    };

    const res = await request(app(['whatsapp'], transport))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'whatsapp', phone: '08011122233' });

    expect(res.body.welcomeSent).toBe(true);
    expect(sent[0]?.template).toBe('mama_triage_welcome_en');
    expect(sent[0]?.params).toEqual(['Amina', 'the MIVA maternal health study']);
  });

  maybe('still registers her when the welcome fails to send', async () => {
    // A failed template is not a failed registration — she can message the number
    // directly. Saying "check WhatsApp" when nothing was sent would be worse.
    const transport = {
      capabilities: { provider: 'meta-cloud-api' },
      async sendTemplate() { throw new Error('Meta rejected the send'); },
    };

    const res = await request(app(['whatsapp'], transport))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'whatsapp', phone: '08011122244' });

    expect(res.status).toBe(200);
    expect(res.body.welcomeSent).toBe(false);
    expect(res.body.instructions).toMatch(/could not send/i);
  });
});

describe('registration validation', () => {
  maybe('requires a display name', async () => {
    const res = await request(app(['telegram']))
      .post('/register/api')
      .send({ displayName: '   ', channel: 'telegram' });
    expect(res.status).toBe(400);
  });

  maybe('rejects a channel this deployment does not offer', async () => {
    const res = await request(app(['telegram']))
      .post('/register/api')
      .send({ displayName: 'Amina', channel: 'whatsapp', phone: '08012345678' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toMatch(/not available/i);
  });
});

describe('web pages', () => {
  maybe('serves the landing page', async () => {
    const res = await request(app(['telegram'])).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!doctype html>');
    expect(res.text).toMatch(/Know when to worry/i);
  });

  maybe('states the emergency instruction on every page', async () => {
    // Above the fold, on every page: if someone lands here while their baby is in danger,
    // reading about the service is the wrong next action.
    for (const path of ['/', '/register']) {
      const res = await request(app(['telegram'])).get(path);
      expect(res.text).toMatch(/If this is an emergency, go to your nearest health facility now/i);
    }
  });

  maybe('says plainly that it is a research prototype and not a doctor', async () => {
    const res = await request(app(['telegram'])).get('/');
    expect(res.text).toMatch(/research prototype/i);
    expect(res.text).toMatch(/not a doctor/i);
    expect(res.text).toMatch(/does not give diagnoses|do not give diagnoses/i);
  });

  maybe('offers only the channels this deployment has', async () => {
    const telegramOnly = await request(app(['telegram'])).get('/register');
    expect(telegramOnly.text).toContain('value="telegram"');
    expect(telegramOnly.text).not.toContain('value="whatsapp"');

    const both = await request(app(['telegram', 'whatsapp'])).get('/register');
    expect(both.text).toContain('value="telegram"');
    expect(both.text).toContain('value="whatsapp"');
  });

  maybe('says so when no channel is configured, rather than showing a dead form', async () => {
    const res = await request(app([])).get('/register');
    expect(res.text).toMatch(/not available right now/i);
  });

  maybe('renders a friendly 404 for a browser and JSON for the API', async () => {
    const page = await request(app(['telegram'])).get('/nope').set('Accept', 'text/html');
    expect(page.status).toBe(404);
    expect(page.text).toMatch(/could not find that page/i);

    const api = await request(app(['telegram'])).get('/register/api/nope');
    expect(api.status).toBe(404);
    expect(api.body.error).toBe('not found');
  });
});

describe('registration form submission', () => {
  maybe('returns the result fragment to htmx, and a full page without it', async () => {
    const frag = await request(app(['telegram']))
      .post('/register')
      .set('HX-Request', 'true')
      .type('form')
      .send({ displayName: 'Amina', channel: 'telegram', language: 'en' });

    expect(frag.status).toBe(200);
    expect(frag.text).toMatch(/Almost there, Amina/);
    expect(frag.text).not.toContain('<!doctype html>'); // a fragment, not a page

    const page = await request(app(['telegram']))
      .post('/register')
      .type('form')
      .send({ displayName: 'Amina', channel: 'telegram', language: 'en' });

    expect(page.status).toBe(200);
    expect(page.text).toContain('<!doctype html>'); // works without JavaScript
  });

  maybe('shows the specific validation message in the returned form', async () => {
    const res = await request(app(['whatsapp']))
      .post('/register')
      .set('HX-Request', 'true')
      .type('form')
      .send({ displayName: 'Amina', channel: 'whatsapp' });

    expect(res.status).toBe(422);
    expect(res.text).toMatch(/A phone number is needed for WhatsApp/);
  });

  maybe('refuses a phone number posted on the Telegram path', async () => {
    // The form removes the field, but the guarantee cannot depend on the form.
    const res = await request(app(['telegram']))
      .post('/register')
      .set('HX-Request', 'true')
      .type('form')
      .send({ displayName: 'Amina', channel: 'telegram', phone: '08012345678' });

    expect(res.status).toBe(422);
    expect(res.text).toMatch(/must not include a phone number/i);
  });

  maybe('tells a Telegram registrant that nothing identifying was stored', async () => {
    const res = await request(app(['telegram']))
      .post('/register')
      .set('HX-Request', 'true')
      .type('form')
      .send({ displayName: 'Amina', channel: 'telegram' });

    expect(res.text).toMatch(/not stored any phone number or contact detail/i);
  });
});
