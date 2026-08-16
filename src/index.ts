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
import { RegistrationRepository } from './db/repositories/registration.repo';
import { FollowUpRepository } from './db/repositories/followup.repo';
import { startFollowUpRunner } from './scheduler/followUpRunner';
import { SmsNotifier } from './sms/notifier';
import { WhatsAppClient } from './whatsapp/client';
import {
  MetaCloudTransport,
  assertTransportUsable,
  type MessageTransport,
} from './whatsapp/transport';
import { TaskQueue } from './http/queue';
import { createApp } from './http/app';
import { createMessageHandler } from './orchestrator/handler';
import { TelegramClient } from './telegram/client';
import { TelegramTransport } from './telegram/transport';
import { MemoryVectorStore } from './rag/store';
import { VoyageEmbedder } from './rag/embed';
import { Retriever } from './rag/retrieve';
import { AnthropicClient } from './llm/anthropic';
import type { ToolCallClient } from './llm/client';
import { DeepSeekClient } from './llm/deepseek';
import { FallbackLlmClient } from './llm/fallbackClient';
import { TriageService } from './llm/triage';
import { BOT_COMMANDS } from './orchestrator/commands';
import { SafetyCheckService } from './llm/safetyCheck';
import { join } from 'node:path';

async function main(): Promise<void> {
  const config = getConfig(); // exits non-zero if invalid
  const logger = createLogger(config.logLevel, !config.isProduction);

  logger.info(
    {
      env: config.env,
      model: config.llm?.model ?? 'not configured',
      promptVersion: config.behaviour.promptVersion,
    },
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
  const registrations = new RegistrationRepository(db);
  const followUps = new FollowUpRepository(db);

  // The knowledge index is built at image build time and shipped read-only. If it is
  // missing the service still starts, but assessment is disabled rather than silently
  // answering ungrounded — the consent and deterministic safety paths keep working.
  const indexPath = !config.rag
    ? null
    : config.rag.chromaPath.endsWith('.json')
      ? config.rag.chromaPath
      : join(config.rag.chromaPath, 'index.json');

  let assessment: Parameters<typeof createMessageHandler>[0]['assessment'];
  let knowledgeIndexSize: number | null = null;
  let assessmentStatus = 'disabled';
  let lastAssessmentFailure: { at: Date; reason: string; error: string } | null = null;
  try {
    if (!indexPath || !config.rag || !config.llm) {
      // Named individually: "credentials missing" is not actionable when there are two of
      // them and the deployment is only missing one.
      const missing = [
        config.llm ? null : 'ANTHROPIC_API_KEY',
        config.rag ? null : 'VOYAGE_API_KEY',
      ].filter(Boolean);
      throw new Error(`not configured: ${missing.join(', ')}`);
    }
    const store = MemoryVectorStore.fromFile(indexPath);
    knowledgeIndexSize = store.size();
    const embedder = new VoyageEmbedder({
      apiKey: config.rag.voyageApiKey,
      model: config.rag.embeddingModel,
    });
    const primary = new AnthropicClient({
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
    });

    // The standby only wraps the primary when it is configured; otherwise the primary is
    // used directly, so nothing about the default path changes.
    const llm: ToolCallClient = config.fallbackLlm
      ? new FallbackLlmClient({
          primary,
          standby: new DeepSeekClient({
            apiKey: config.fallbackLlm.apiKey,
            model: config.fallbackLlm.model,
            timeoutMs: config.llm.timeoutMs,
          }),
          onFallback: ({ reason, error, recovered }) => {
            // Audited every time. An evaluation has to be able to say how many decisions
            // came from each model; a figure averaged over both describes neither.
            void audit.record('LLM_FALLBACK_USED' as never, { reason, error, recovered });
            logger.warn(
              { reason, error, recovered, standby: config.fallbackLlm?.model },
              recovered
                ? 'primary LLM unavailable — answered by the standby provider'
                : 'primary LLM unavailable and the standby also failed',
            );
          },
        })
      : primary;

    if (config.fallbackLlm) {
      logger.info({ standby: config.fallbackLlm.model }, 'standby LLM provider configured');
    }

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
        // Assessment can be fully configured and still fail on every call — an expired
        // key, an exhausted credit balance, a model the account cannot reach. The mother
        // gets the correct fallback either way, so from outside the container that is
        // indistinguishable from working. Keeping the last failure makes it visible on
        // /readyz without a probe request on every health check.
        if (event === 'LLM_FAILOVER' || event === 'RETRIEVAL_FAILED') {
          const d = detail as { reason?: string; error?: string };
          lastAssessmentFailure = {
            at: new Date(),
            reason: d.reason ?? event,
            error: (d.error ?? '').slice(0, 160),
          };
        }
        void audit.record(event as never, detail);
      },
    };

    assessmentStatus = `ok (${store.size()} chunks, ${store.embeddingModel})`;

    logger.info(
      { chunks: store.size(), embeddingModel: store.embeddingModel, builtAt: store.builtAt },
      'knowledge index loaded',
    );
  } catch (err) {
    assessmentStatus = `disabled — ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(
      { reason: assessmentStatus, indexPath },
      'assessment disabled — deterministic safety layer, consent and pathway selection ' +
        'remain fully active',
    );
  }

  // One transport per configured channel. A mother chooses her channel at registration,
  // and her session is keyed by channel + identifier, so both can run side by side.
  const transports = new Map<string, MessageTransport>();

  if (config.whatsapp) {
    const wa = new MetaCloudTransport(
      new WhatsAppClient({
        token: config.whatsapp.token,
        phoneNumberId: config.whatsapp.phoneNumberId,
      }),
    );
    // Fails fast on a send-only provider rather than silently dropping every inbound
    // message while appearing to work.
    assertTransportUsable(wa);
    transports.set('whatsapp', wa);
  }

  let telegramClient: TelegramClient | undefined;
  if (config.telegram) {
    telegramClient = new TelegramClient({ token: config.telegram.botToken });
    const tg = new TelegramTransport(telegramClient);
    assertTransportUsable(tg);
    transports.set('telegram', tg);

    // Publish the command menu. Not awaited into the boot path and never fatal: the menu
    // is a discoverability aid, and a bot that refuses to start because Telegram was slow
    // to accept a list of labels would be trading a working triage service for a button.
    void telegramClient
      .setMyCommands(BOT_COMMANDS)
      .then(() => logger.info({ commands: BOT_COMMANDS.length }, 'telegram command menu published'))
      .catch((err: unknown) =>
        logger.warn({ err }, 'could not publish the telegram command menu — commands still work'),
      );
  }

  logger.info(
    { channels: [...transports.keys()] },
    'messaging channels ready',
  );

  const queue = new TaskQueue({
    concurrency: 4,
    onError: (err) => logger.error({ err }, 'queued task failed'),
  });

  // One factory, so the demo interface can bind the same handler to a capturing
  // transport and exercise exactly the code path a WhatsApp message takes.
  const makeHandler = (transport: MessageTransport) =>
    createMessageHandler({
      sessions,
      messages,
      audit,
      outcomes,
      registrations,
      followUps,
      whatsapp: transport,
      logger,
      pepper: config.privacy.phoneHashPepper,
      sessionTtlMinutes: config.behaviour.sessionTtlMinutes,
      ...(assessment ? { assessment } : {}),
    });

  const handleMessage = transports.has('whatsapp')
    ? makeHandler(transports.get('whatsapp') as MessageTransport)
    : async (): Promise<void> => undefined;

  const handleTelegram = transports.has('telegram')
    ? makeHandler(transports.get('telegram') as MessageTransport)
    : undefined;

  const app = createApp({
    appSecret: config.whatsapp?.appSecret ?? '',
    verifyToken: config.whatsapp?.verifyToken ?? '',
    whatsappEnabled: Boolean(config.whatsapp),
    assessmentStatus: () => {
      if (!lastAssessmentFailure) return assessmentStatus;
      const { at, reason, error } = lastAssessmentFailure;
      const minutesAgo = Math.round((Date.now() - at.getTime()) / 60000);
      return `${assessmentStatus}; last failure ${minutesAgo}m ago: ${reason}${
        error ? ` — ${error}` : ''
      }`;
    },
    ...(config.telegram && telegramClient && handleTelegram
      ? {
          telegram: {
            secretToken: config.telegram.webhookSecret,
            client: telegramClient,
            handleMessage: handleTelegram,
          },
        }
      : {}),
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
    register: {
      registrations,
      pepper: config.privacy.phoneHashPepper,
      availableChannels: [...transports.keys()] as Array<'whatsapp' | 'telegram'>,
      ...(config.telegram?.botUsername
        ? { telegramBotUsername: config.telegram.botUsername }
        : {}),
      ...(transports.has('whatsapp')
        ? { whatsappTransport: transports.get('whatsapp') as MessageTransport }
        : {}),
      studyName: process.env.STUDY_NAME ?? 'the MIVA maternal health study',
    },
    demo: {
      // Off by default in production: it is an unauthenticated chat interface onto the
      // triage engine. Enable deliberately with DEMO_ENABLED=true.
      enabled: process.env.DEMO_ENABLED === 'true' || !config.isProduction,
      makeHandler,
      sessions,
      outcomes,
      pepper: config.privacy.phoneHashPepper,
      sessionTtlMinutes: config.behaviour.sessionTtlMinutes,
    },
  });

  // SMS reminders are optional infrastructure: configured or not, the chat reminder is
  // what the follow-up depends on.
  const smsNotifier =
    process.env.KUDISMS_TOKEN && process.env.KUDISMS_SENDER_ID
      ? new SmsNotifier({
          token: process.env.KUDISMS_TOKEN,
          senderId: process.env.KUDISMS_SENDER_ID,
        })
      : undefined;
  if (smsNotifier) logger.info('SMS reminders enabled');

  const followUpRunner = startFollowUpRunner({
    followUps,
    transports,
    logger,
    registrations,
    ...(smsNotifier ? { sms: smsNotifier } : {}),
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
          const addresses = await followUps.purgeStaleRecipients();
          if (expired || purged || addresses) {
            logger.debug({ expired, purged, addresses }, 'housekeeping');
          }
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
    followUpRunner.stop();
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
