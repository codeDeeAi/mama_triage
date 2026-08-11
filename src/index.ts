/**
 * Service entrypoint.
 *
 * Boots in dependency order and fails fast: configuration is validated before anything
 * else, and the database must answer before the HTTP server starts accepting traffic.
 */

import { getConfig } from './config';
import { createLogger } from './telemetry/logger';
import { createDb } from './db/pool';
import { SessionRepository } from './db/repositories/session.repo';
import { MessageRepository } from './db/repositories/message.repo';
import { AuditRepository, WebhookEventRepository } from './db/repositories/event.repo';
import { WhatsAppClient } from './whatsapp/client';
import { TaskQueue } from './http/queue';
import { createApp } from './http/app';
import { createMessageHandler } from './orchestrator/handler';

async function main(): Promise<void> {
  const config = getConfig(); // exits non-zero if invalid
  const logger = createLogger(config.logLevel, !config.isProduction);

  logger.info(
    { env: config.env, model: config.llm.model, promptVersion: config.behaviour.promptVersion },
    'starting mama-triage',
  );

  const db = createDb(config.databaseUrl);
  if (!(await db.healthy())) {
    logger.fatal('database unreachable at startup');
    process.exit(1);
  }

  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const events = new WebhookEventRepository(db);
  const audit = new AuditRepository(db);

  const whatsapp = new WhatsAppClient({
    token: config.whatsapp.token,
    phoneNumberId: config.whatsapp.phoneNumberId,
  });

  const queue = new TaskQueue({
    concurrency: 4,
    onError: (err) => logger.error({ err }, 'queued task failed'),
  });

  const handleMessage = createMessageHandler({
    sessions,
    messages,
    audit,
    whatsapp,
    logger,
    pepper: config.privacy.phoneHashPepper,
    sessionTtlMinutes: config.behaviour.sessionTtlMinutes,
  });

  const app = createApp({
    appSecret: config.whatsapp.appSecret,
    verifyToken: config.whatsapp.verifyToken,
    db,
    events,
    audit,
    queue,
    logger,
    handleMessage,
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'listening');
  });

  // Housekeeping: expire stale sessions and purge the idempotency ledger.
  const housekeeping = setInterval(
    () => {
      void (async () => {
        try {
          const expired = await sessions.expireStale(config.behaviour.sessionTtlMinutes);
          const purged = await events.purgeOlderThan(7);
          if (expired || purged) logger.debug({ expired, purged }, 'housekeeping');
        } catch (err) {
          logger.error({ err }, 'housekeeping failed');
        }
      })();
    },
    15 * 60 * 1000,
  );
  housekeeping.unref();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    clearInterval(housekeeping);
    server.close(() => {
      void (async () => {
        // Let in-flight triage turns finish before closing the pool — a mother
        // mid-assessment should not lose her reply to a deploy.
        await queue.onIdle();
        await db.close();
        logger.info('shutdown complete');
        process.exit(0);
      })();
    });
    // Cloud Run allows a limited drain window; do not exceed it.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
