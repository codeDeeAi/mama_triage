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
import { OutcomeRepository } from './db/repositories/outcome.repo';
import { WhatsAppClient } from './whatsapp/client';
import { TaskQueue } from './http/queue';
import { createApp } from './http/app';
import { createMessageHandler } from './orchestrator/handler';
import { MemoryVectorStore } from './rag/store';
import { VoyageEmbedder } from './rag/embed';
import { Retriever } from './rag/retrieve';
import { AnthropicClient } from './llm/anthropic';
import { TriageService } from './llm/triage';
import { SafetyCheckService } from './llm/safetyCheck';
import { join } from 'node:path';

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
  const outcomes = new OutcomeRepository(db);

  // The knowledge index is built at image build time and shipped read-only. If it is
  // missing the service still starts, but assessment is disabled rather than silently
  // answering ungrounded — the consent and deterministic safety paths keep working.
  const indexPath = config.rag.chromaPath.endsWith('.json')
    ? config.rag.chromaPath
    : join(config.rag.chromaPath, 'index.json');

  let assessment: Parameters<typeof createMessageHandler>[0]['assessment'];
  let knowledgeIndexSize: number | null = null;
  try {
    const store = MemoryVectorStore.fromFile(indexPath);
    knowledgeIndexSize = store.size();
    const embedder = new VoyageEmbedder({
      apiKey: config.rag.voyageApiKey,
      model: config.rag.embeddingModel,
    });
    const llm = new AnthropicClient({
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
    });

    assessment = {
      retriever: new Retriever(store, embedder, { topK: config.rag.topK }),
      triage: new TriageService({
        client: llm,
        model: config.llm.model,
        maxTokens: config.llm.maxTokens,
        promptVersion: config.behaviour.promptVersion,
      }),
      safetyCheck: new SafetyCheckService({ client: llm, model: config.llm.safetyModel }),
      onAudit: (event, detail) => {
        void audit.record(event as never, detail);
      },
    };

    logger.info(
      { chunks: store.size(), embeddingModel: store.embeddingModel, builtAt: store.builtAt },
      'knowledge index loaded',
    );
  } catch (err) {
    logger.error(
      { err, indexPath },
      'knowledge index unavailable — assessment disabled, safety paths still active',
    );
  }

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
    outcomes,
    whatsapp,
    logger,
    pepper: config.privacy.phoneHashPepper,
    sessionTtlMinutes: config.behaviour.sessionTtlMinutes,
    ...(assessment ? { assessment } : {}),
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
    admin: {
      isProduction: config.isProduction,
      ...(process.env.ADMIN_TOKEN ? { adminToken: process.env.ADMIN_TOKEN } : {}),
      ...(assessment ? { assessment, retriever: assessment.retriever } : {}),
      ...(knowledgeIndexSize !== null ? { indexSize: () => knowledgeIndexSize as number } : {}),
    },
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
