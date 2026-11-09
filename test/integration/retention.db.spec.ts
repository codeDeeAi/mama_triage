/**
 * Retention against a real database: conversation text goes first, the pseudonymised
 * session and its structured outcome later, and safety audit events survive both.
 */

import { createDb, type Db } from '../../src/db/pool';
import { MessageRepository } from '../../src/db/repositories/message.repo';
import { SessionRepository } from '../../src/db/repositories/session.repo';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';

let db: Db;
let available = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL, 4);
  available = await db.healthy();
});
afterAll(async () => { if (db) await db.close(); });

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => { if (!available) return; await fn(); });

let n = 0;
/** A session whose last activity was `daysAgo` days ago, with one message and one outcome. */
async function sessionAged(daysAgo: number): Promise<string> {
  n += 1;
  const s = await db.one<{ id: string }>(
    `INSERT INTO sessions (wa_id_hash, pathway, state, last_activity_at)
     VALUES ($1, 'maternal', 'completed', NOW() - ($2 || ' days')::interval) RETURNING id`,
    [`ret${n}-${Date.now()}`.padEnd(64, '0'), String(daysAgo)],
  );
  const id = s!.id;
  await new MessageRepository(db).record({
    sessionId: id,
    direction: 'inbound',
    body: 'my stitches are painful',
    detectedLang: 'en',
  } as never);
  await db.query(
    `INSERT INTO triage_outcomes (session_id, pathway, urgency, model, prompt_version)
     VALUES ($1, 'maternal', 'facility_visit', 'test', 'triage.v2')`,
    [id],
  );
  await db.query(
    `INSERT INTO audit_log (session_id, event, detail) VALUES ($1, 'RED_FLAG_HIT', $2::jsonb)`,
    [id, JSON.stringify({ marker: id })],
  );
  return id;
}

const count = async (sql: string, id: string): Promise<number> =>
  Number((await db.one<{ c: string }>(sql, [id]))?.c ?? 0);

describe('retention', () => {
  maybe('deletes transcripts after the transcript period but keeps the outcome', async () => {
    const old = await sessionAged(91);
    const recent = await sessionAged(10);

    await new MessageRepository(db).purgeTranscriptsOlderThan(90);

    expect(await count('SELECT count(*)::text AS c FROM messages WHERE session_id = $1', old)).toBe(0);
    expect(await count('SELECT count(*)::text AS c FROM triage_outcomes WHERE session_id = $1', old)).toBe(1);
    expect(await count('SELECT count(*)::text AS c FROM messages WHERE session_id = $1', recent)).toBe(1);
  });

  maybe('deletes the session and its outcome after the outcome period', async () => {
    const old = await sessionAged(400);
    const kept = await sessionAged(100);

    await new SessionRepository(db).purgeInactiveOlderThan(365);

    expect(await count('SELECT count(*)::text AS c FROM sessions WHERE id = $1', old)).toBe(0);
    expect(await count('SELECT count(*)::text AS c FROM triage_outcomes WHERE session_id = $1', old)).toBe(0);
    expect(await count('SELECT count(*)::text AS c FROM sessions WHERE id = $1', kept)).toBe(1);
    // The safety event outlives the session, detached from it.
    expect(
      await count(
        "SELECT count(*)::text AS c FROM audit_log WHERE detail->>'marker' = $1 AND session_id IS NULL",
        old,
      ),
    ).toBe(1);
  });
});
