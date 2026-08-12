/**
 * End-to-end handler tests against a real PostgreSQL instance.
 *
 * These exercise the paths that in-memory fakes cannot prove: the session lifecycle, the
 * urgency ratchet trigger, PII redaction on the way into `messages`, and the audit trail.
 *
 * Requires the local database:  npm run db:up && npm run db:migrate
 * Skipped automatically when DATABASE_URL is not reachable, so CI without a database
 * still passes the rest of the suite.
 */

import { createDb, type Db } from '../../src/db/pool';
import { SessionRepository } from '../../src/db/repositories/session.repo';
import { MessageRepository } from '../../src/db/repositories/message.repo';
import { AuditRepository, WebhookEventRepository } from '../../src/db/repositories/event.repo';
import { createMessageHandler, CONSENT_ACCEPT_ID, CONSENT_DECLINE_ID, PATHWAY_BABY_ID } from '../../src/orchestrator/handler';
import { hashPhone } from '../../src/privacy/hashPhone';
import type { InboundMessage } from '../../src/whatsapp/types';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';
const PEPPER = 'test-pepper-'.padEnd(64, 'x');

let db: Db;
let available = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL, 4);
  available = await db.healthy();
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn(`\n[skip] database unreachable at ${DATABASE_URL} — run npm run db:up\n`);
    return;
  }

});

afterAll(async () => {
  if (db) await db.close();
});

/** Captures outbound sends instead of calling Meta. */
class FakeWhatsApp {
  readonly texts: Array<{ to: string; body: string }> = [];
  readonly buttons: Array<{ to: string; body: string; ids: string[] }> = [];

  async sendText(to: string, body: string) {
    this.texts.push({ to, body });
    return [{ waMessageId: `wamid.out.${this.texts.length}` }];
  }
  async sendOptions(to: string, body: string, buttons: ReadonlyArray<{ id: string; title: string }>) {
    this.buttons.push({ to, body, ids: buttons.map((b) => b.id) });
    return { waMessageId: `wamid.btn.${this.buttons.length}` };
  }
  get allBodies(): string {
    return [...this.texts.map((t) => t.body), ...this.buttons.map((b) => b.body)].join('\n');
  }
}

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

interface Ctx {
  send: (text: string, opts?: { replyId?: string; kind?: InboundMessage['kind'] }) => Promise<void>;
  wa: FakeWhatsApp;
  sessions: SessionRepository;
  audit: AuditRepository;
  phone: string;
  waIdHash: string;
}

let seq = 0;

function ctx(): Ctx {
  const wa = new FakeWhatsApp();
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const audit = new AuditRepository(db);

  // Unique per test so sessions never collide across runs.
  seq += 1;
  const phone = `23480${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;

  const handle = createMessageHandler({
    sessions, messages, audit,
    whatsapp: wa as never,
    logger: silentLogger,
    pepper: PEPPER,
    sessionTtlMinutes: 60,
  });

  let n = 0;
  const send = async (
    text: string,
    opts: { replyId?: string; kind?: InboundMessage['kind'] } = {},
  ): Promise<void> => {
    n += 1;
    await handle({
      waMessageId: `wamid.${phone}.${n}`,
      from: phone,
      text,
      kind: opts.kind ?? (opts.replyId ? 'interactive' : 'text'),
      timestamp: Math.floor(Date.now() / 1000),
      phoneNumberId: 'PNID',
      ...(opts.replyId ? { replyId: opts.replyId } : {}),
    });
  };

  return { send, wa, sessions, audit, phone, waIdHash: hashPhone(phone, PEPPER) };
}

async function currentSession(c: Ctx) {
  return c.sessions.findActive(c.waIdHash, 60);
}

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });

describe('consent flow', () => {
  maybe('asks for consent on first contact', async () => {
    const c = ctx();
    await c.send('hello');

    expect(c.wa.buttons).toHaveLength(1);
    expect(c.wa.buttons[0]?.ids).toEqual(['CONSENT_ACCEPT', 'CONSENT_DECLINE']);
    expect(c.wa.buttons[0]?.body).toMatch(/not a doctor/i);
    expect(c.wa.buttons[0]?.body).toMatch(/research prototype/i);
    expect((await currentSession(c))?.state).toBe('awaiting_consent');
  });

  maybe('records consent and offers the pathway choice', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('Yes, continue', { replyId: CONSENT_ACCEPT_ID });

    const session = await currentSession(c);
    expect(session?.consent_at).not.toBeNull();
    expect(session?.state).toBe('choosing_pathway');
    expect(c.wa.buttons[1]?.ids).toEqual(['PATHWAY_MOTHER', 'PATHWAY_BABY']);

    const events = await c.audit.listForSession(session!.id);
    expect(events.map((e) => e.event)).toContain('CONSENT_GIVEN');
  });

  maybe('accepts a typed "yes" as well as the button', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes');
    expect((await currentSession(c))?.state).toBe('choosing_pathway');
  });

  maybe('ends the session cleanly when consent is declined', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('No, thank you', { replyId: CONSENT_DECLINE_ID });

    expect(c.wa.allBodies).toMatch(/completely fine/i);
    expect(c.wa.allBodies).toMatch(/nearest health facility/i);
    // Session is terminal, so it is no longer the active one.
    expect(await currentSession(c)).toBeNull();
  });

  maybe('re-prompts on an ambiguous answer', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('what is this?');
    expect(c.wa.allBodies).toMatch(/tap \*Yes, continue\*/i);
    expect((await currentSession(c))?.state).toBe('awaiting_consent');
  });
});

describe('pathway routing', () => {
  maybe('routes to the neonatal pathway', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes', { replyId: CONSENT_ACCEPT_ID });
    await c.send('For my baby', { replyId: PATHWAY_BABY_ID });

    const session = await currentSession(c);
    expect(session?.pathway).toBe('neonatal');
    expect(session?.state).toBe('assessing');
  });

  maybe('routes free text mentioning the baby to the neonatal pathway', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes');
    await c.send('it is for my baby');
    expect((await currentSession(c))?.pathway).toBe('neonatal');
  });

  maybe('routes to the maternal pathway', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes');
    await c.send('for me');
    expect((await currentSession(c))?.pathway).toBe('maternal');
  });
});

describe('safety escalation — before consent', () => {
  maybe('escalates an emergency without first asking for consent', async () => {
    // The requirement that matters most: a mother whose baby has stopped breathing must
    // not be shown a data-protection notice first.
    const c = ctx();
    await c.send('my baby is not breathing');

    expect(c.wa.allBodies).toMatch(/EMERGENCY/);
    expect(c.wa.allBodies).toMatch(/nearest health facility now/i);
    expect(c.wa.buttons).toHaveLength(0); // no consent prompt was sent

    const session = await c.sessions.findById(
      (await db.one<{ id: string }>(
        `SELECT id FROM sessions WHERE wa_id_hash = $1 ORDER BY started_at DESC LIMIT 1`,
        [c.waIdHash],
      ))!.id,
    );
    expect(session?.state).toBe('escalated');
    expect(session?.urgency_current).toBe('emergency');
  });

  maybe('writes an audit trail for the escalation', async () => {
    const c = ctx();
    await c.send('she is having convulsions');

    const row = await db.one<{ id: string }>(
      `SELECT id FROM sessions WHERE wa_id_hash = $1 ORDER BY started_at DESC LIMIT 1`,
      [c.waIdHash],
    );
    const events = (await c.audit.listForSession(row!.id)).map((e) => e.event);
    expect(events).toContain('RED_FLAG_HIT');
    expect(events).toContain('EMERGENCY_ISSUED');
  });

  maybe('leads and closes the emergency message with the referral directive', async () => {
    const c = ctx();
    await c.send('I am bleeding heavily');

    const body = c.wa.texts[0]!.body;
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    // Referral appears immediately after the banner, and again at the end.
    expect(lines[1]).toMatch(/nearest health facility now/i);
    expect(body).toMatch(/nearest health facility now[\s\S]*nearest health facility now/i);
  });

  maybe('answers a Pidgin emergency in Pidgin', async () => {
    const c = ctx();
    await c.send('blood dey rush');

    const body = c.wa.texts[0]!.body;
    expect(body).toMatch(/EMERGENCY/);
    expect(body).toMatch(/health centre wey dey near you now now/i);
    // The referral still brackets the message, in the mother's language.
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    expect(lines[1]).toMatch(/health centre wey dey near you/i);
  });

  maybe('adds mental-health support wording for distress', async () => {
    const c = ctx();
    await c.send('I want to kill myself');

    expect(c.wa.allBodies).toMatch(/EMERGENCY/);
    expect(c.wa.allBodies).toMatch(/you are not alone/i);
  });

  maybe('does not escalate reassuring text', async () => {
    const c = ctx();
    await c.send('hello, the baby is feeding well and has no fever');

    expect(c.wa.allBodies).not.toMatch(/EMERGENCY/);
    expect(c.wa.buttons).toHaveLength(1); // consent prompt instead
  });

  maybe('escalates on a danger sign following a reassuring clause', async () => {
    const c = ctx();
    await c.send('no fever, but blood dey rush');
    expect(c.wa.allBodies).toMatch(/EMERGENCY/);
  });
});

describe('urgency ratchet across turns', () => {
  maybe('never lowers urgency once raised', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes');
    await c.send('for my baby');
    // A facility-visit flag first.
    await c.send('the cord is red with pus');

    let session = await currentSession(c);
    expect(session?.urgency_current).toBe('facility_visit');

    // Then benign text — urgency must not fall back.
    await c.send('otherwise he seems fine and is feeding');
    session = await currentSession(c);
    expect(session?.urgency_current).toBe('facility_visit');
  });
});

describe('privacy', () => {
  maybe('never stores the phone number in the session', async () => {
    const c = ctx();
    await c.send('hello');

    const rows = await db.query<{ wa_id_hash: string }>(
      `SELECT wa_id_hash FROM sessions WHERE wa_id_hash = $1`,
      [c.waIdHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wa_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.wa_id_hash).not.toContain(c.phone);
  });

  maybe('redacts a phone number out of a stored message body', async () => {
    const c = ctx();
    await c.send('hello');
    await c.send('yes');
    await c.send('for my baby');
    await c.send('please call my husband on 08033445566');

    const rows = await db.query<{ body_redacted: string }>(
      `SELECT m.body_redacted FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.wa_id_hash = $1 AND m.direction = 'inbound'`,
      [c.waIdHash],
    );
    const bodies = rows.map((r) => r.body_redacted).join('\n');
    expect(bodies).not.toMatch(/08033445566/);
    expect(bodies).toMatch(/\[phone\]/);
  });

  maybe('stores both sides of the conversation', async () => {
    const c = ctx();
    await c.send('hello');

    const rows = await db.query<{ direction: string }>(
      `SELECT m.direction FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.wa_id_hash = $1`,
      [c.waIdHash],
    );
    expect(rows.map((r) => r.direction)).toEqual(
      expect.arrayContaining(['inbound', 'outbound']),
    );
  });
});

describe('unsupported message types', () => {
  maybe('tells the mother it can only read text', async () => {
    const c = ctx();
    await c.send('', { kind: 'unsupported' });
    expect(c.wa.allBodies).toMatch(/only read text messages/i);
  });
});

describe('webhook event repository', () => {
  maybe('claims a message ID exactly once', async () => {
    if (!available) return;
    const events = new WebhookEventRepository(db);
    const id = `wamid.claim.${Date.now()}`;

    expect(await events.claim(id)).toBe(true);
    expect(await events.claim(id)).toBe(false);
    expect(await events.claim(id)).toBe(false);

    await events.markProcessed(id);
    const row = await db.one<{ status: string }>(
      `SELECT status FROM webhook_events WHERE wa_message_id = $1`,
      [id],
    );
    expect(row?.status).toBe('processed');
  });

  maybe('allows reprocessing after a release', async () => {
    const events = new WebhookEventRepository(db);
    const id = `wamid.release.${Date.now()}`;

    expect(await events.claim(id)).toBe(true);
    await events.release(id);
    expect(await events.claim(id)).toBe(true);
  });
});

describe('language switching mid-conversation', () => {
  maybe('answers in Pidgin when the mother switches to it after an English opener', async () => {
    // A mother may open with "hello" and switch to Pidgin once she describes symptoms.
    // Detecting language only at session creation left her reading an emergency
    // referral in the wrong language — found by the demo interface.
    const c = ctx();
    await c.send('hello');
    await c.send('my pikin no gree chop at all');

    expect(c.wa.allBodies).toMatch(/EMERGENCY/);
    expect(c.wa.allBodies).toMatch(/health centre wey dey near you/i);
  });

  maybe('does not switch away from Pidgin on an ambiguous message', async () => {
    const c = ctx();
    await c.send('abeg my pikin dey sick');
    await c.send('ok');
    // Once Pidgin is detected it is kept; the heuristic only ever upgrades to pcm.
    const row = await db.one<{ language: string }>(
      `SELECT language FROM sessions WHERE wa_id_hash=$1 ORDER BY started_at DESC LIMIT 1`,
      [c.waIdHash],
    );
    expect(row?.language).toBe('pcm');
  });
});
