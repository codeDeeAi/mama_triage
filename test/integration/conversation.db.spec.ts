/**
 * Full conversation, end to end, against a real PostgreSQL instance.
 *
 * The LLM and embedder are scripted doubles — this proves the wiring, the persistence and
 * the safety guarantees, not the model's clinical judgement. Model behaviour is what the
 * evaluation harness measures.
 *
 * Requires: npm run db:up && npm run db:migrate
 */

import { createDb, type Db } from '../../src/db/pool';
import { SessionRepository } from '../../src/db/repositories/session.repo';
import { MessageRepository } from '../../src/db/repositories/message.repo';
import { AuditRepository } from '../../src/db/repositories/event.repo';
import { OutcomeRepository } from '../../src/db/repositories/outcome.repo';
import { createMessageHandler, CONSENT_ACCEPT_ID, PATHWAY_BABY_ID } from '../../src/orchestrator/handler';
import { hashPhone } from '../../src/privacy/hashPhone';
import { LlmError } from '../../src/llm/anthropic';
import type { AssessmentDeps } from '../../src/orchestrator/assessment';
import type { RetrievalOutcome } from '../../src/rag/retrieve';
import type { TriageDecision } from '../../src/llm/triage';
import type { Slots, Urgency } from '../../src/types';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mama:mama@localhost:5433/mama_triage';
const PEPPER = 'conv-test-pepper'.padEnd(64, 'z');

let db: Db;
let available = false;

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

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

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });

class FakeWhatsApp {
  readonly texts: string[] = [];
  readonly buttons: string[] = [];
  async sendText(_to: string, body: string) {
    this.texts.push(body);
    return [{ waMessageId: 'out' }];
  }
  async sendButtons(_to: string, body: string) {
    this.buttons.push(body);
    return { waMessageId: 'btn' };
  }
  get all(): string {
    return [...this.texts, ...this.buttons].join('\n');
  }
  get last(): string {
    return this.texts[this.texts.length - 1] ?? '';
  }
}

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

const retrieval: RetrievalOutcome = {
  results: [
    {
      chunk: {
        chunkId: 'placeholder#2', documentSlug: 'placeholder', title: 'P',
        publisher: 'P', section: 'Feeding', pathway: 'neonatal', topics: [],
        tokenCount: 10, text: 'guidance',
      },
      score: 0.7,
    },
  ],
  query: 'q', grounded: true, topScore: 0.7,
};

/** Scripted decisions, consumed one per assessment turn. */
function scriptedAssessment(
  script: Array<{ urgency: Urgency; slots?: Slots; ask?: string } | Error>,
): AssessmentDeps {
  let i = 0;
  return {
    retriever: { retrieve: async () => retrieval } as never,
    triage: {
      assess: async (): Promise<TriageDecision> => {
        const step = script[Math.min(i, script.length - 1)]!;
        i += 1;
        if (step instanceof Error) throw step;
        const action = step.ask
          ? { type: 'ask', domain: 'breathing', question: step.ask }
          : {
              type: 'conclude',
              meaning: 'Here is what this means.',
              steps: ['Do this first'],
              return_warnings: ['Come back if it worsens'],
            };
        return {
          urgency: step.urgency,
          urgencyLlm: step.urgency,
          urgencyRules: null,
          escalatedBy: null,
          redFlags: [],
          slots: step.slots ?? {},
          citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
          model: 'claude-sonnet-5',
          promptVersion: 'triage.v1',
          inputTokens: 120, outputTokens: 60, latencyMs: 900,
          ungrounded: false,
          result: {
            detected_language: 'en', pathway: 'neonatal',
            extracted_slots: step.slots ?? {}, red_flags: [],
            urgency: step.urgency, confidence: 'high',
            citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
            rationale: 'scripted reasoning',
            next_action: action as never,
          } as never,
        };
      },
    } as never,
    safetyCheck: {
      check: async (inp: { proposed: Urgency }) => ({
        urgency: inp.proposed, escalated: false, reason: null,
        failedOpen: false, inputTokens: 10, outputTokens: 5, latencyMs: 200,
      }),
    } as never,
  };
}

let seq = 0;

function ctx(assessment?: AssessmentDeps) {
  const wa = new FakeWhatsApp();
  const sessions = new SessionRepository(db);
  const outcomes = new OutcomeRepository(db);
  const audit = new AuditRepository(db);

  seq += 1;
  const phone = `23470${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;

  const handle = createMessageHandler({
    sessions,
    messages: new MessageRepository(db),
    audit,
    outcomes,
    whatsapp: wa as never,
    logger: silentLogger,
    pepper: PEPPER,
    sessionTtlMinutes: 60,
    ...(assessment ? { assessment } : {}),
  });

  let n = 0;
  const send = async (text: string, replyId?: string): Promise<void> => {
    n += 1;
    await handle({
      waMessageId: `wamid.${phone}.${n}`,
      from: phone,
      text,
      kind: replyId ? 'interactive' : 'text',
      timestamp: Math.floor(Date.now() / 1000),
      phoneNumberId: 'PNID',
      ...(replyId ? { replyId } : {}),
    });
  };

  const waIdHash = hashPhone(phone, PEPPER);
  return {
    send, wa, sessions, outcomes, audit, waIdHash,
    async session() {
      const row = await db.one<{ id: string }>(
        `SELECT id FROM sessions WHERE wa_id_hash=$1 ORDER BY started_at DESC LIMIT 1`,
        [waIdHash],
      );
      return row ? sessions.findById(row.id) : null;
    },
  };
}

/** Walk consent and pathway selection. */
async function reachAssessing(c: ReturnType<typeof ctx>): Promise<void> {
  await c.send('hello');
  await c.send('Yes, continue', CONSENT_ACCEPT_ID);
  await c.send('For my baby', PATHWAY_BABY_ID);
}

describe('full conversation', () => {
  maybe('runs consent, pathway, question, and conclusion', async () => {
    const c = ctx(
      scriptedAssessment([
        { urgency: 'self_care', slots: { feeding: 'normal' }, ask: 'How is the baby breathing?' },
        { urgency: 'self_care', slots: { breathing: 'normal' } },
      ]),
    );

    await reachAssessing(c);
    expect((await c.session())?.state).toBe('assessing');

    await c.send('he is feeding normally');
    expect(c.wa.last).toBe('How is the baby breathing?');
    expect((await c.session())?.state).toBe('assessing');

    await c.send('breathing is normal');
    expect(c.wa.last).toContain('CARE AT HOME');
    expect(c.wa.last).toContain('What to do now');
    expect((await c.session())?.state).toBe('completed');
  });

  maybe('accumulates slots across turns', async () => {
    const c = ctx(
      scriptedAssessment([
        { urgency: 'self_care', slots: { feeding: 'normal' }, ask: 'And breathing?' },
        { urgency: 'self_care', slots: { breathing: 'normal' } },
      ]),
    );

    await reachAssessing(c);
    await c.send('feeding is fine');
    await c.send('breathing is fine');

    const session = await c.session();
    expect(session?.slots).toMatchObject({ feeding: 'normal', breathing: 'normal' });
  });

  maybe('persists a triage outcome with full provenance', async () => {
    const c = ctx(scriptedAssessment([{ urgency: 'facility_visit' }]));
    await reachAssessing(c);
    await c.send('the cord looks red');

    const session = await c.session();
    const rows = await c.outcomes.listForSession(session!.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      urgency: 'facility_visit',
      urgency_llm: 'facility_visit',
      pathway: 'neonatal',
    });

    const full = await db.one<{ model: string; prompt_version: string; input_tokens: number }>(
      `SELECT model, prompt_version, input_tokens FROM triage_outcomes WHERE session_id=$1`,
      [session!.id],
    );
    expect(full?.model).toBe('claude-sonnet-5');
    expect(full?.prompt_version).toBe('triage.v1');
    expect(full?.input_tokens).toBe(120);
  });
});

describe('emergency during assessment', () => {
  maybe('escalates, ends the session, and audits it', async () => {
    const c = ctx(scriptedAssessment([{ urgency: 'emergency' }]));
    await reachAssessing(c);
    await c.send('he has stopped feeding completely');

    expect(c.wa.last).toContain('EMERGENCY');
    expect(c.wa.last).toMatch(/nearest health facility now/i);

    const session = await c.session();
    expect(session?.state).toBe('escalated');
    expect(session?.urgency_current).toBe('emergency');

    const events = (await c.audit.listForSession(session!.id)).map((e) => e.event);
    expect(events).toContain('EMERGENCY_ISSUED');
  });

  maybe('holds urgency at emergency for the rest of the session', async () => {
    const c = ctx(scriptedAssessment([{ urgency: 'emergency' }, { urgency: 'self_care' }]));
    await reachAssessing(c);
    await c.send('he has stopped feeding completely');

    // The escalated session keeps its state and urgency permanently...
    const session = await c.session();
    expect(session?.state).toBe('escalated');
    expect(session?.urgency_current).toBe('emergency');

    // ...and is no longer active, so a further message starts a fresh session rather
    // than resuming an assessment that has already issued a referral.
    expect(await c.sessions.findActive(c.waIdHash, 60)).toBeNull();

    await c.send('is he ok now?');
    const after = await db.query<{ state: string }>(
      `SELECT state FROM sessions WHERE wa_id_hash=$1 ORDER BY started_at ASC`,
      [c.waIdHash],
    );
    expect(after.length).toBe(2);
    expect(after[0]?.state).toBe('escalated'); // the original is untouched
  });
});

describe('urgency ratchet across assessment turns', () => {
  maybe('refuses to lower urgency established earlier', async () => {
    const c = ctx(
      scriptedAssessment([
        { urgency: 'facility_visit', ask: 'Anything else?' },
        { urgency: 'self_care' },
      ]),
    );

    await reachAssessing(c);
    await c.send('the cord is red');
    expect((await c.session())?.urgency_current).toBe('facility_visit');

    await c.send('otherwise he is fine');
    // The DB trigger and raiseUrgency both refuse the downgrade.
    expect((await c.session())?.urgency_current).toBe('facility_visit');
  });
});

describe('LLM failure during assessment', () => {
  maybe('sends the static fallback and ends safely', async () => {
    const c = ctx(scriptedAssessment([new LlmError('down', 'timeout')]));
    await reachAssessing(c);
    await c.send('he seems unwell');

    expect(c.wa.last).toMatch(/not able to complete/i);
    expect(c.wa.last).toMatch(/unable to suck at the breast/i);
    expect(c.wa.last).toMatch(/nearest health facility/i);

    const session = await c.session();
    expect(session?.state).toBe('completed');

    const events = (await c.audit.listForSession(session!.id)).map((e) => e.event);
    expect(events).toContain('LLM_FAILOVER');
  });

  maybe('records no outcome row when the model produced nothing', async () => {
    const c = ctx(scriptedAssessment([new LlmError('down', 'timeout')]));
    await reachAssessing(c);
    await c.send('he seems unwell');

    const session = await c.session();
    expect(await c.outcomes.listForSession(session!.id)).toHaveLength(0);
  });
});

describe('assessment unavailable', () => {
  maybe('tells the mother rather than failing silently', async () => {
    const c = ctx(); // no assessment services wired
    await reachAssessing(c);
    await c.send('he seems unwell');

    expect(c.wa.last).toMatch(/not available right now/i);
    expect(c.wa.last).toMatch(/nearest health facility/i);
  });
});

describe('disagreement statistics for the report', () => {
  maybe('counts escalations by source', async () => {
    const stats = await new OutcomeRepository(db).disagreementStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(typeof stats.rulesEscalated).toBe('number');
    expect(typeof stats.safetyCheckEscalated).toBe('number');
    expect(typeof stats.lowConfidencePromoted).toBe('number');
  });
});
