/**
 * Telegram webhook route.
 *
 * Same shape as the WhatsApp webhook and for the same reasons: authenticate, ACK
 * immediately, claim the update for idempotency, then hand off to the async handler.
 *
 * Authentication differs. Telegram has no HMAC signature; instead `setWebhook` registers
 * a `secret_token` which Telegram echoes in the `X-Telegram-Bot-Api-Secret-Token` header
 * on every update. That is a shared secret rather than a signature, so it is compared in
 * constant time and the endpoint is useless to anyone who does not hold it.
 */

import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { parseUpdate, type ParsedUpdate } from '../telegram/parseUpdate';
import type { TelegramClient } from '../telegram/client';
import type { WebhookEventRepository } from '../db/repositories/event.repo';
import type { TaskQueue } from './queue';
import type { Logger } from '../telemetry/logger';

export interface TelegramWebhookDeps {
  /** Must match the `secret_token` passed to setWebhook. */
  secretToken: string;
  client: TelegramClient;
  events: WebhookEventRepository;
  queue: TaskQueue;
  logger: Logger;
  handleMessage: (msg: ParsedUpdate) => Promise<void>;
  onReject?: (reason: string) => void;
}

function secretsMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createTelegramRouter(deps: TelegramWebhookDeps): Router {
  const router = Router();

  router.post('/telegram/webhook', (req: Request, res: Response) => {
    const provided = req.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
    if (!secretsMatch(provided, deps.secretToken)) {
      deps.logger.warn('telegram webhook rejected: bad secret token');
      deps.onReject?.('bad secret token');
      res.sendStatus(401);
      return;
    }

    // ACK first. Telegram retries an update it does not see acknowledged promptly, and a
    // triage turn takes seconds.
    res.sendStatus(200);

    const msg = parseUpdate(req.body);
    if (!msg) return; // join events, edits, and anything else this system does not act on

    deps.queue.push(async () => {
      const claimed = await deps.events.claim(msg.waMessageId);
      if (!claimed) {
        deps.logger.debug({ updateId: msg.waMessageId }, 'duplicate telegram update dropped');
        return;
      }

      // Acknowledge a button tap before doing the work, or the client shows a spinner on
      // the button for the whole assessment and reads as having hung.
      if (msg.callbackQueryId) {
        await deps.client.answerCallback(msg.callbackQueryId).catch(() => {
          /* cosmetic only; never block the assessment on it */
        });
      }

      try {
        await deps.handleMessage(msg);
        await deps.events.markProcessed(msg.waMessageId);
      } catch (err) {
        deps.logger.error({ err, updateId: msg.waMessageId }, 'telegram message failed');
        await deps.events.markFailed(msg.waMessageId);
        throw err;
      }
    });
  });

  return router;
}
