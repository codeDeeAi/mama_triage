import request from 'supertest';
import { createApp } from '../../src/http/app';
import { TaskQueue } from '../../src/http/queue';
import type { AssessmentDeps } from '../../src/orchestrator/assessment';
import type { RetrievalOutcome } from '../../src/rag/retrieve';
import type { TriageDecision } from '../../src/llm/triage';
import type { Urgency } from '../../src/types';

const silentLogger = {
  info: () => undefined, warn: () => undefined,
  error: () => undefined, debug: () => undefined,
} as never;

const retrieval: RetrievalOutcome = {
  results: [
    {
      chunk: {
        chunkId: 'placeholder#2', documentSlug: 'placeholder', title: 'P', publisher: 'WHO',
        section: 'Feeding', pathway: 'neonatal', topics: [], tokenCount: 10,
        text: 'Not able to feed is a general danger sign.',
      },
      score: 0.72,
    },
  ],
  query: 'young infant not able to feed', grounded: true, topScore: 0.72,
};

function assessment(urgency: Urgency = 'self_care'): AssessmentDeps {
  return {
    retriever: { retrieve: async () => retrieval } as never,
    triage: {
      assess: async (): Promise<TriageDecision> => ({
        urgency, urgencyLlm: urgency, urgencyRules: null, escalatedBy: null,
        redFlags: [], slots: {}, citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
        model: 'test', promptVersion: 'triage.v1',
        inputTokens: 10, outputTokens: 5, latencyMs: 50, ungrounded: false,
        result: {
          detected_language: 'en', pathway: 'neonatal', extracted_slots: {},
          red_flags: [], urgency, confidence: 'high',
          citations: [{ chunk_id: 'placeholder#2', claim: 'c' }],
          rationale: 'r',
          next_action: {
            type: 'conclude', meaning: 'Seems well.',
            steps: ['Rest'], return_warnings: ['Return if worse'],
          } as never,
        } as never,
      }),
    } as never,
    safetyCheck: {
      check: async (i: { proposed: Urgency }) => ({
        urgency: i.proposed, escalated: false, reason: null, failedOpen: false,
        inputTokens: 0, outputTokens: 0, latencyMs: 0,
      }),
    } as never,
  };
}

function app(admin: Record<string, unknown> | undefined) {
  return createApp({
    appSecret: 'secret',
    verifyToken: 'verify',
    events: { async claim() { return true; }, async markProcessed() {}, async markFailed() {} } as never,
    audit: { async record() {} } as never,
    db: { healthy: async () => true } as never,
    queue: new TaskQueue(),
    logger: silentLogger,
    handleMessage: async () => undefined,
    ...(admin ? { admin: admin as never } : {}),
  });
}

describe('/admin — access control', () => {
  it('is absent entirely when no admin config is supplied', async () => {
    const res = await request(app(undefined)).get('/admin/register');
    expect(res.status).toBe(404);
  });

  it('is open in development when no token is configured', async () => {
    const res = await request(app({ isProduction: false })).get('/admin/register');
    expect(res.status).toBe(200);
  });

  it('is hidden in production when no token is configured', async () => {
    // A debug endpoint that drives the triage engine must not be left open.
    const res = await request(app({ isProduction: true })).get('/admin/register');
    expect(res.status).toBe(404);
  });

  it('requires the bearer token when one is configured', async () => {
    const a = app({ isProduction: true, adminToken: 'sekrit' });
    expect((await request(a).get('/admin/register')).status).toBe(401);
    expect((await request(a).get('/admin/register').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(a).get('/admin/register').set('Authorization', 'Bearer sekrit')).status).toBe(200);
  });
});

describe('GET /admin/register — the verification gate', () => {
  it('reports the register as not reportable while rules are unverified', async () => {
    const res = await request(app({ isProduction: false })).get('/admin/register');
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.reportable).toBe(false);
    expect(res.body.pending.length).toBeGreaterThan(0);
    expect(res.body.pending).toContain('MAT_CONVULSION');
  });
});

describe('POST /admin/kb/query', () => {
  it('returns ranked chunks with their citations', async () => {
    const res = await request(app({ isProduction: false, retriever: assessment().retriever }))
      .post('/admin/kb/query')
      .send({ query: 'baby not feeding', pathway: 'neonatal' });

    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    expect(res.body.results[0].chunkId).toBe('placeholder#2');
    expect(res.body.results[0].publisher).toBe('WHO');
  });

  it('rejects a malformed request', async () => {
    const res = await request(app({ isProduction: false, retriever: assessment().retriever }))
      .post('/admin/kb/query')
      .send({ pathway: 'neonatal' });
    expect(res.status).toBe(400);
  });

  it('reports 503 when the index failed to load', async () => {
    const res = await request(app({ isProduction: false }))
      .post('/admin/kb/query')
      .send({ query: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('POST /admin/simulate', () => {
  it('drives a full assessment without WhatsApp', async () => {
    const res = await request(app({ isProduction: false, assessment: assessment('self_care') }))
      .post('/admin/simulate')
      .send({ pathway: 'neonatal', language: 'en', turns: ['he is feeding well'] });

    expect(res.status).toBe(200);
    expect(res.body.urgency).toBe('self_care');
    expect(res.body.replies[0]).toContain('CARE AT HOME');
    expect(res.body.turnsProcessed).toBe(1);
  });

  it('applies the deterministic safety scan before the model', async () => {
    // The same guarantee the real handler gives: the hard stop does not depend on the
    // model, so a simulated run exercises it identically.
    const res = await request(app({ isProduction: false, assessment: assessment('self_care') }))
      .post('/admin/simulate')
      .send({ pathway: 'neonatal', turns: ['the baby is not feeding at all'] });

    expect(res.body.urgency).toBe('emergency');
    expect(res.body.redFlags).toContain('NEO_NOT_FEEDING');
    expect(res.body.escalatedBy).toBe('rules');
    expect(res.body.replies[0]).toContain('EMERGENCY');
  });

  it('stops after an emergency rather than continuing to ask', async () => {
    const res = await request(app({ isProduction: false, assessment: assessment('self_care') }))
      .post('/admin/simulate')
      .send({
        pathway: 'neonatal',
        turns: ['the baby is not feeding at all', 'what should I do now?'],
      });
    expect(res.body.turnsProcessed).toBe(1);
  });

  it('handles Pidgin', async () => {
    const res = await request(app({ isProduction: false, assessment: assessment('self_care') }))
      .post('/admin/simulate')
      .send({ pathway: 'neonatal', language: 'pcm', turns: ['pikin no dey chop'] });

    expect(res.body.urgency).toBe('emergency');
    expect(res.body.replies[0]).toMatch(/health centre wey dey near you/i);
  });

  it('rejects a malformed request', async () => {
    const res = await request(app({ isProduction: false, assessment: assessment() }))
      .post('/admin/simulate')
      .send({ pathway: 'nonsense', turns: [] });
    expect(res.status).toBe(400);
  });

  it('reports 503 when assessment is unavailable', async () => {
    const res = await request(app({ isProduction: false }))
      .post('/admin/simulate')
      .send({ pathway: 'neonatal', turns: ['hello'] });
    expect(res.status).toBe(503);
  });
});
