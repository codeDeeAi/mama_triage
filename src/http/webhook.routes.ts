/**
 * WhatsApp webhook routes.
 *
 * Two responsibilities, in strict order:
 *
 *   1. GET  /webhook — Meta's one-time subscription handshake.
 *   2. POST /webhook — inbound messages: verify signature, ACK immediately, claim the
 *      message ID for idempotency, then hand off to the async handler.
 *
 * The ACK-before-work ordering is not a performance optimisation. Meta retries a delivery
 * it does not see acknowledged promptly; without both the early 200 and the idempotency
 * claim, a slow triage turn causes the mother to receive the same emergency directive
 * two or three times.
 */

import { Router, type Request, type Response } from 'express';
import type { InboundMessage } from '../whatsapp/types';
import { parseInbound } from '../whatsapp/parseInbound';
import type { VerifiedRequest } from './middleware/verifySignature';
import type { TaskQueue } from './queue';
import type { WebhookEventRepository } from '../db/repositories/event.repo';
import type { Logger } from '../telemetry/logger';

export interface WebhookDeps {
  verifyToken: string;
  events: WebhookEventRepository;
  queue: TaskQueue;
  logger: Logger;
  /** The message handler. Runs off the request path. */
  handleMessage: (msg: InboundMessage) => Promise<void>;
}

export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  /**
   * Subscription handshake. Meta calls this once when the webhook URL is registered and
   * echoes back the challenge if the verify token matches.
   */
  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === deps.verifyToken && typeof challenge === 'string') {
      deps.logger.info('webhook subscription verified');
      res.status(200).send(challenge);
      return;
    }

    deps.logger.warn({ mode }, 'webhook verification rejected');
    res.sendStatus(403);
  });

  /**
   * Inbound delivery. Mounted behind `express.raw` + `verifySignature`, so by the time
   * this runs the payload is authenticated and parsed.
   */
  router.post('/webhook', (req: VerifiedRequest, res: Response) => {
    // ACK first. Nothing below may delay this.
    res.sendStatus(200);

    const messages = parseInbound(req.verifiedBody);
    if (messages.length === 0) return; // status callback or unrecognised payload

    for (const msg of messages) {
      deps.queue.push(async () => {
        // Idempotency: whoever wins the claim processes the message. A Meta retry loses
        // and is dropped here, before any reply is sent.
        const claimed = await deps.events.claim(msg.waMessageId);
        if (!claimed) {
          deps.logger.debug({ waMessageId: msg.waMessageId }, 'duplicate delivery dropped');
          return;
        }

        try {
          await deps.handleMessage(msg);
          await deps.events.markProcessed(msg.waMessageId);
        } catch (err) {
          deps.logger.error(
            { err, waMessageId: msg.waMessageId },
            'message handling failed',
          );
          await deps.events.markFailed(msg.waMessageId);
          throw err; // surfaces to the queue's onError for metrics
        }
      });
    }
  });

  return router;
}
