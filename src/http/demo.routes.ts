/**
 * Web demonstration interface.
 *
 * A browser chat that drives the **real** message handler — same consent flow, same
 * deterministic safety scan, same assessment state machine, same persistence — with the
 * WhatsApp transport swapped for one that captures replies into an array.
 *
 * This exists for three reasons, and it is worth being precise about which:
 *
 *   1. **Demonstration without a WhatsApp provider.** Meta approval has lead time and
 *      resellers may not support two-way messaging at all. The system can be shown
 *      working, end to end, today.
 *   2. **Clinical review.** A reviewer can try the system themselves and — via the
 *      inspector panel — see *why* it answered as it did: which red flags fired, what
 *      each layer proposed, which guideline chunks were cited.
 *   3. **Evidence for the report.** Screenshots of a working assessment, with the
 *      reasoning visible.
 *
 * It is NOT a replacement for the WhatsApp channel. The thesis claim is zero-install
 * accessibility over a channel mothers already use; a browser demo does not satisfy that
 * and must not be presented as if it did.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageTransport, TransportCapabilities } from '../whatsapp/transport';
import { renderOptionsAsText } from '../whatsapp/transport';
import type { ReplyButton } from '../whatsapp/types';
import type { InboundMessage } from '../whatsapp/types';
import { evaluateRedFlags } from '../safety/redFlags';
import { hashPhone } from '../privacy/hashPhone';
import { detectDistress } from '../safety/distress';
import type { SessionRepository } from '../db/repositories/session.repo';
import type { OutcomeRepository } from '../db/repositories/outcome.repo';
import type { Logger } from '../telemetry/logger';

/** Collects outbound messages instead of sending them. */
export class CapturingTransport implements MessageTransport {
  readonly capabilities: TransportCapabilities = {
    inbound: true,
    freeTextOutbound: true,
    // The web client renders options as buttons itself, so numbered text is used for
    // the transcript and the option IDs are returned separately.
    interactiveButtons: false,
    provider: 'web-demo',
  };

  readonly sent: string[] = [];
  readonly options: ReplyButton[] = [];

  async sendText(_to: string, body: string): Promise<void> {
    this.sent.push(body);
  }

  async sendOptions(_to: string, body: string, options: readonly ReplyButton[]): Promise<void> {
    this.sent.push(renderOptionsAsText(body, options));
    this.options.length = 0;
    this.options.push(...options);
  }
}

export interface DemoDeps {
  /**
   * Builds a handler bound to the supplied transport. The demo needs a fresh capturing
   * transport per request, so the handler cannot be constructed once at boot.
   */
  makeHandler: (transport: MessageTransport) => (msg: InboundMessage) => Promise<void>;
  sessions: SessionRepository;
  outcomes?: OutcomeRepository;
  pepper: string;
  sessionTtlMinutes: number;
  logger: Logger;
  enabled: boolean;
}

const MessageRequest = z.object({
  sessionId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  /** Set when the user clicked an option rather than typing. */
  replyId: z.string().max(60).optional(),
});

/**
 * Demo sessions are keyed by a synthetic phone number derived from a UUID, so they flow
 * through exactly the same hashing and session lookup as a real WhatsApp contact. The
 * `999` prefix keeps them distinguishable from real Nigerian numbers in the database.
 */
function syntheticPhone(sessionId: string): string {
  const digits = sessionId.replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  return `999${digits}`;
}

export function createDemoRouter(deps: DemoDeps): Router {
  const router = Router();

  router.use('/demo/api', (_req: Request, res: Response, next) => {
    if (!deps.enabled) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  });

  /** Start a fresh demo conversation. */
  router.post('/demo/api/session', (_req: Request, res: Response) => {
    const sessionId = randomUUID();
    deps.logger.info({ sessionId }, 'demo session started');
    res.json({ sessionId });
  });

  /**
   * Send one message and get the replies.
   *
   * Runs the real handler, so consent, the safety scan, slot filling and persistence all
   * behave exactly as they would for a message arriving over WhatsApp.
   */
  router.post('/demo/api/message', async (req: Request, res: Response) => {
    const parsed = MessageRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
      return;
    }
    const { sessionId, text, replyId } = parsed.data;
    const from = syntheticPhone(sessionId);

    const transport = new CapturingTransport();
    const handle = deps.makeHandler(transport);

    const started = Date.now();
    try {
      await handle({
        waMessageId: `demo.${sessionId}.${randomUUID()}`,
        from,
        text,
        kind: replyId ? 'interactive' : 'text',
        timestamp: Math.floor(Date.now() / 1000),
        phoneNumberId: 'DEMO',
        ...(replyId ? { replyId } : {}),
      });
    } catch (err) {
      deps.logger.error({ err, sessionId }, 'demo message failed');
      res.status(500).json({ error: 'assessment failed', detail: String(err) });
      return;
    }

    // Inspector data: what the deterministic layer saw in this message, and where the
    // session stands. This is what makes the demo useful to a clinical reviewer.
    const waIdHash = hashPhone(from, deps.pepper);
    // Deliberately not findActive: an escalated or completed session is exactly the one
    // a reviewer most wants to inspect, and findActive excludes terminal states.
    const session = await deps.sessions.findLatest(waIdHash);

    const scan = evaluateRedFlags({
      text,
      pathway: session?.pathway ?? 'unset',
    });
    const distress = detectDistress(text);

    const outcomes = session && deps.outcomes ? await deps.outcomes.listForSession(session.id) : [];
    const latest = outcomes[outcomes.length - 1];

    res.json({
      replies: transport.sent,
      options: transport.options,
      latencyMs: Date.now() - started,
      inspector: {
        state: session?.state ?? 'completed_or_escalated',
        pathway: session?.pathway ?? null,
        language: session?.language ?? null,
        urgency: session?.urgency_current ?? null,
        slots: session?.slots ?? {},
        redFlagsThisTurn: scan.hits.map((h) => ({
          id: h.id,
          urgency: h.urgency,
          via: h.via,
          evidence: h.evidence,
          source: h.source,
        })),
        distress: distress.detected ? distress.categories : [],
        lastOutcome: latest
          ? {
              urgency: latest.urgency,
              urgencyLlm: latest.urgency_llm,
              urgencyRules: latest.urgency_rules,
              escalatedBy: latest.escalated_by,
            }
          : null,
      },
    });
  });

  return router;
}
