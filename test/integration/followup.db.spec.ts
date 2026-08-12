/**
 * Follow-up lifecycle against a real database.
 *
 * Covers what pure functions cannot: the partial unique index, SKIP LOCKED claiming,
 * retry budgeting, and — most importantly — that the plaintext address is discarded the
 * moment it is no longer needed.
 */

import { createDb, type Db } from '../../src/db/pool';
import { FollowUpRepository, MAX_ATTEMPTS } from '../../src/db/repositories/followup.repo';
import { runFollowUps } from '../../src/scheduler/followUpRunner';
import type { MessageTransport } from '../../src/whatsapp/transport';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';

let db: Db;
let repo: FollowUpRepository;
let available = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL, 4);
  available = await db.healthy();
  if (available) repo = new FollowUpRepository(db);
});
afterAll(async () => { if (db) await db.close(); });

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => { if (!available) return; await fn(); });

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

let n = 0;
async function newSession(): Promise<string> {
  n += 1;
  const row = await db.one<{ id: string }>(
    `INSERT INTO sessions (wa_id_hash, pathway, state)
     VALUES ($1, 'neonatal', 'completed') RETURNING id`,
    [`fu${n}`.padEnd(64, '0')],
  );
  return row!.id;
}

const past = (): Date => new Date(Date.now() - 60_000);

async function schedule(sessionId: string, over: Record<string, unknown> = {}) {
  return repo.schedule({
    sessionId,
    identityHash: 'h'.repeat(64),
    recipient: '900123456',
    channel: 'telegram',
    language: 'en',
    displayName: 'Amina',
    reason: 'jaundice',
    intervalDays: 1,
    dueAt: past(),
    ...over,
  } as never);
}

/** Transport double that records sends. */
function transports(fail = false) {
  const sent: Array<{ to: string; body: string }> = [];
  const t: MessageTransport = {
    capabilities: { inbound: true, freeTextOutbound: true, interactiveButtons: true, provider: 'telegram' },
    async sendText(to: string, body: string) {
      if (fail) throw new Error('network down');
      sent.push({ to, body });
    },
    async sendOptions() { /* unused */ },
    async sendTemplate() { /* unused */ },
  };
  return { sent, map: new Map([['telegram', t]]) };
}

describe('scheduling', () => {
  maybe('queues a follow-up', async () => {
    const row = await schedule(await newSession());
    expect(row?.reason).toBe('jaundice');
    expect(row?.status).toBe('pending');
  });

  maybe('does not queue a second reminder for the same finding', async () => {
    // A mother who messages twice about the same jaundice should be reminded once.
    const sessionId = await newSession();
    expect(await schedule(sessionId)).not.toBeNull();
    expect(await schedule(sessionId)).toBeNull();
    expect(await repo.listForSession(sessionId)).toHaveLength(1);
  });

  maybe('allows a different finding on the same session', async () => {
    const sessionId = await newSession();
    await schedule(sessionId, { reason: 'jaundice' });
    await schedule(sessionId, { reason: 'local_bacterial_infection' });
    expect(await repo.listForSession(sessionId)).toHaveLength(2);
  });
});

describe('delivery', () => {
  maybe('sends a due reminder on the mother\'s own channel', async () => {
    const sessionId = await newSession();
    await schedule(sessionId);

    const tr = transports();
    const result = await runFollowUps({ followUps: repo, transports: tr.map, logger: silentLogger });

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(tr.sent[0]?.to).toBe('900123456');
    expect(tr.sent[0]?.body).toMatch(/How is your baby now/);
  });

  maybe('discards the plaintext address once the reminder is sent', async () => {
    // The address exists only for the day or two until delivery. This is the assertion
    // that keeps that promise honest.
    const sessionId = await newSession();
    await schedule(sessionId);

    await runFollowUps({ followUps: repo, transports: transports().map, logger: silentLogger });

    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.recipient).toBeNull();
  });

  maybe('does not send a reminder that is not yet due', async () => {
    const sessionId = await newSession();
    await schedule(sessionId, { dueAt: new Date(Date.now() + 3_600_000) });

    const tr = transports();
    await runFollowUps({ followUps: repo, transports: tr.map, logger: silentLogger });

    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.status).toBe('pending');
  });

  maybe('retries a transient failure rather than dropping it', async () => {
    const sessionId = await newSession();
    await schedule(sessionId);

    await runFollowUps({ followUps: repo, transports: transports(true).map, logger: silentLogger });

    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.status).toBe('pending'); // still queued
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.last_error).toMatch(/network down/);
  });

  maybe('gives up after the attempt budget, and discards the address', async () => {
    const sessionId = await newSession();
    await schedule(sessionId);

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runFollowUps({ followUps: repo, transports: transports(true).map, logger: silentLogger });
    }

    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.recipient).toBeNull();
  });

  maybe('skips a channel this deployment no longer runs', async () => {
    const sessionId = await newSession();
    await schedule(sessionId, { channel: 'whatsapp' });

    const result = await runFollowUps({
      followUps: repo,
      transports: new Map(), // nothing configured
      logger: silentLogger,
    });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('cancellation', () => {
  maybe('cancels pending reminders when a later turn escalates to emergency', async () => {
    // She has been told to go now. A reminder in two days would read as though the
    // referral were optional.
    const sessionId = await newSession();
    await schedule(sessionId);

    const cancelled = await repo.cancelForSession(sessionId, 'superseded by an emergency referral');
    expect(cancelled).toBe(1);

    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.recipient).toBeNull();
  });

  maybe('a cancelled reminder is never sent', async () => {
    const sessionId = await newSession();
    await schedule(sessionId);
    await repo.cancelForSession(sessionId, 'escalated');

    const tr = transports();
    await runFollowUps({ followUps: repo, transports: tr.map, logger: silentLogger });
    expect(tr.sent).toHaveLength(0);
  });
});

describe('housekeeping', () => {
  maybe('purges addresses left on non-pending rows', async () => {
    const sessionId = await newSession();
    await schedule(sessionId);
    // Simulate a row that reached a terminal state without going through markSent.
    await db.query(`UPDATE follow_ups SET status = 'failed' WHERE session_id = $1`, [sessionId]);

    await repo.purgeStaleRecipients();
    const rows = await repo.listForSession(sessionId);
    expect(rows[0]?.recipient).toBeNull();
  });

  maybe('reports delivery figures for the report', async () => {
    const stats = await repo.stats();
    expect(typeof stats.sent).toBe('number');
    expect(typeof stats.pending).toBe('number');
    expect(typeof stats.cancelled).toBe('number');
  });
});
