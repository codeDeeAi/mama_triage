/**
 * Admin and debug routes.
 *
 * `/admin/simulate` is the evaluation runner's entry point against a deployed instance:
 * the same orchestrator, a different transport. It exists so Objective 4 can be measured
 * without a WhatsApp round trip, and so development continues while Meta approval is
 * pending.
 *
 * These routes are gated by a bearer token and are refused outright in production unless
 * one is configured. A debug endpoint that drives the triage engine is not something to
 * leave open.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { detectDistress } from '../safety/distress';
import {
  evaluateRedFlags,
  RED_FLAGS,
  registerFullyAssured,
  simulatedRules,
  unverifiedRules,
} from '../safety/redFlags';
import { buildEmergencyMessage } from '../orchestrator/render';
import { ratchet } from '../safety/ratchet';
import { runAssessmentTurn, type AssessmentDeps } from '../orchestrator/assessment';
import type { Retriever } from '../rag/retrieve';
import type { Language, Pathway, Slots, Urgency } from '../types';
import type { Logger } from '../telemetry/logger';

export interface AdminDeps {
  logger: Logger;
  /** Absent when the knowledge index failed to load. */
  assessment?: AssessmentDeps;
  retriever?: Retriever;
  /** Required in production; when unset, admin routes are disabled there. */
  adminToken?: string;
  isProduction: boolean;
  indexSize?: () => number;
}

const SimulateRequest = z.object({
  pathway: z.enum(['maternal', 'neonatal']),
  language: z.enum(['en', 'pcm']).default('en'),
  turns: z.array(z.string().min(1)).min(1).max(20),
});

const KbQueryRequest = z.object({
  query: z.string().min(1),
  pathway: z.enum(['maternal', 'neonatal', 'unset']).default('unset'),
});

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (deps.isProduction && !deps.adminToken) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (deps.adminToken) {
      const provided = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (provided !== deps.adminToken) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    next();
  };

  router.use('/admin', guard);

  /** Register status — lets the runner check the verification gate before a run. */
  router.get('/admin/register', (_req: Request, res: Response) => {
    const pending = unverifiedRules();
    const simulated = simulatedRules();
    res.json({
      total: RED_FLAGS.length,
      verified: RED_FLAGS.length - pending.length,
      pending: pending.map((r) => r.id),
      // Verified by a placeholder rather than a clinician. Reported separately so a
      // simulated review cannot read as clinical validation.
      simulated: simulated.map((r) => r.id),
      // The gate the evaluation runner uses: every rule has a decision.
      reportable: pending.length === 0,
      // The stronger claim: every decision is backed by a real source.
      fullyAssured: registerFullyAssured(),
    });
  });

  /** Retrieval debugging: what does the knowledge base return for this query? */
  router.post('/admin/kb/query', async (req: Request, res: Response) => {
    if (!deps.retriever) {
      res.status(503).json({ error: 'knowledge index unavailable' });
      return;
    }
    const parsed = KbQueryRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
      return;
    }

    const outcome = await deps.retriever.retrieve({
      pathway: parsed.data.pathway as Pathway,
      slots: {},
      message: parsed.data.query,
    });

    res.json({
      query: outcome.query,
      grounded: outcome.grounded,
      topScore: outcome.topScore,
      results: outcome.results.map((r) => ({
        chunkId: r.chunk.chunkId,
        score: r.score,
        publisher: r.chunk.publisher,
        section: r.chunk.section,
        pathway: r.chunk.pathway,
        excerpt: r.chunk.text.slice(0, 300),
      })),
      indexSize: deps.indexSize?.() ?? null,
    });
  });

  /**
   * Drive a full assessment without WhatsApp.
   *
   * Mirrors the handler's ordering exactly — the deterministic safety scan runs on every
   * turn before the assessment — so a simulated run exercises the same guarantees a real
   * message does.
   */
  router.post('/admin/simulate', async (req: Request, res: Response) => {
    if (!deps.assessment) {
      res.status(503).json({ error: 'assessment unavailable — knowledge index not loaded' });
      return;
    }

    const parsed = SimulateRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
      return;
    }
    const { pathway, language, turns } = parsed.data;

    const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const replies: string[] = [];
    let slots: Slots = {};
    let urgency: Urgency | null = null;
    let urgencyLlm: Urgency | null = null;
    let escalatedBy: string | null = null;
    const redFlags = new Set<string>();
    let terminated = false;
    let fallbackReason: string | undefined;

    const started = Date.now();

    for (const message of turns) {
      if (terminated) break;
      transcript.push({ role: 'user', content: message });

      const distress = detectDistress(message);
      const scan = evaluateRedFlags({ text: message, slots, pathway: pathway as Pathway });
      for (const hit of scan.hits) redFlags.add(hit.id);
      if (scan.urgency) urgency = ratchet(urgency, scan.urgency);

      if (scan.urgency === 'emergency' || distress.detected) {
        urgency = 'emergency';
        escalatedBy = escalatedBy ?? 'rules';
        const body = buildEmergencyMessage(
          language as Language,
          distress.needsMentalHealthReferral,
        );
        replies.push(body);
        transcript.push({ role: 'assistant', content: body });
        terminated = true;
        break;
      }

      const outcome = await runAssessmentTurn(deps.assessment, {
        pathway: pathway as Pathway,
        language: language as Language,
        knownSlots: slots,
        currentUrgency: urgency,
        transcript,
        message,
      });

      slots = outcome.slots;
      if (outcome.urgency) urgency = ratchet(urgency, outcome.urgency);
      if (outcome.decision) {
        urgencyLlm = outcome.decision.urgencyLlm;
        escalatedBy = outcome.decision.escalatedBy ?? escalatedBy;
        for (const f of outcome.decision.redFlags) redFlags.add(f.id);
      }
      if (outcome.fallbackReason) fallbackReason = outcome.fallbackReason;

      for (const body of outcome.messages) {
        replies.push(body);
        transcript.push({ role: 'assistant', content: body });
      }
      if (outcome.state !== 'assessing') terminated = true;
    }

    res.json({
      urgency: urgency ?? 'self_care',
      urgencyLlm,
      escalatedBy,
      redFlags: [...redFlags],
      slots,
      replies,
      turnsProcessed: transcript.filter((t) => t.role === 'user').length,
      latencyMs: Date.now() - started,
      ...(fallbackReason ? { fallbackReason } : {}),
    });
  });

  return router;
}
