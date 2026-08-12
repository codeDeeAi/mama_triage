/**
 * Telegram long-polling runner — local development and handset testing.
 *
 * A webhook needs a public HTTPS URL. Long polling needs nothing: `getUpdates` is called
 * from wherever the process happens to be running, so the bot can be tested from a real
 * phone against a laptop with no tunnel, no deployment and no DNS.
 *
 * It drives exactly the same handler the webhook does — same consent flow, same
 * deterministic safety scan, same persistence — so what is tested here is the system, not
 * a development stand-in.
 *
 * Production uses the webhook. Telegram refuses to serve `getUpdates` while a webhook is
 * registered, so this deletes it on start; re-register before deploying.
 *
 * Run with: npm run telegram:poll
 */

import { getConfig } from '../config';
import { createLogger } from '../telemetry/logger';
import { createDb } from '../db/pool';
import { SessionRepository } from '../db/repositories/session.repo';
import { MessageRepository } from '../db/repositories/message.repo';
import { AuditRepository } from '../db/repositories/event.repo';
import { OutcomeRepository } from '../db/repositories/outcome.repo';
import { createMessageHandler } from '../orchestrator/handler';
import { MemoryVectorStore } from '../rag/store';
import { VoyageEmbedder } from '../rag/embed';
import { Retriever } from '../rag/retrieve';
import { AnthropicClient } from '../llm/anthropic';
import { TriageService } from '../llm/triage';
import { SafetyCheckService } from '../llm/safetyCheck';
import { TelegramClient } from './client';
import { TelegramTransport } from './transport';
import { parseUpdate } from './parseUpdate';
import { join } from 'node:path';

/** Raw getUpdates call — not on the client, because only this runner needs it. */
async function getUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }),
  });

  const json = (await res.json()) as {
    ok?: boolean;
    result?: Array<Record<string, unknown>>;
    description?: string;
  };
  if (!json.ok) throw new Error(`getUpdates failed: ${json.description ?? 'unknown'}`);
  return json.result ?? [];
}

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config.logLevel, true);

  if (!config.telegram) {
    process.stderr.write(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are not configured.\n',
    );
    process.exit(1);
  }

  const db = createDb(config.databaseUrl);
  if (!(await db.healthy())) {
    logger.fatal('database unreachable — run: npm run db:up && npm run db:migrate');
    process.exit(1);
  }

  const client = new TelegramClient({ token: config.telegram.botToken });
  const me = await client.getMe();
  logger.info({ bot: me.username }, 'connected to Telegram');

  // getUpdates and a registered webhook are mutually exclusive.
  await client.deleteWebhook();

  const sessions = new SessionRepository(db);
  const audit = new AuditRepository(db);

  let assessment: Parameters<typeof createMessageHandler>[0]['assessment'];
  try {
    if (!config.llm || !config.rag) throw new Error('LLM credentials not configured');
    const indexPath = config.rag.chromaPath.endsWith('.json')
      ? config.rag.chromaPath
      : join(config.rag.chromaPath, 'index.json');
    const store = MemoryVectorStore.fromFile(indexPath);
    const llm = new AnthropicClient({
      apiKey: config.llm.apiKey,
      timeoutMs: config.llm.timeoutMs,
    });
    assessment = {
      retriever: new Retriever(
        store,
        new VoyageEmbedder({ apiKey: config.rag.voyageApiKey, model: config.rag.embeddingModel }),
        { topK: config.rag.topK },
      ),
      triage: new TriageService({
        client: llm,
        model: config.llm.model,
        maxTokens: config.llm.maxTokens,
        promptVersion: config.behaviour.promptVersion,
      }),
      safetyCheck: new SafetyCheckService({ client: llm, model: config.llm.safetyModel }),
      onAudit: (event, detail) => void audit.record(event as never, detail),
    };
    logger.info({ chunks: store.size() }, 'assessment enabled');
  } catch (err) {
    logger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'assessment disabled — consent flow and deterministic safety layer still active',
    );
  }

  const handle = createMessageHandler({
    sessions,
    messages: new MessageRepository(db),
    audit,
    outcomes: new OutcomeRepository(db),
    whatsapp: new TelegramTransport(client),
    logger,
    pepper: config.privacy.phoneHashPepper,
    sessionTtlMinutes: config.behaviour.sessionTtlMinutes,
    ...(assessment ? { assessment } : {}),
  });

  logger.info(
    { link: `https://t.me/${me.username}` },
    'polling for messages — open the link on your phone and send /start',
  );

  let offset = 0;
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      // 25s long poll: Telegram holds the request open until an update arrives, so this
      // is one request per message rather than a busy loop.
      const updates = await getUpdates(config.telegram.botToken, offset, 25);

      for (const raw of updates) {
        offset = Math.max(offset, (raw.update_id as number) + 1);

        const msg = parseUpdate(raw);
        if (!msg) continue;

        if (msg.callbackQueryId) {
          await client.answerCallback(msg.callbackQueryId).catch(() => undefined);
        }

        logger.info({ from: '[redacted]', kind: msg.kind }, 'inbound');
        try {
          await handle(msg);
        } catch (err) {
          logger.error({ err }, 'handler failed');
          // Tell her something rather than going quiet, then continue polling.
          await client
            .sendMessage(
              msg.from,
              'Sorry, something went wrong on my side. If you are worried about ' +
                'anything, please go to your nearest health facility.',
            )
            .catch(() => undefined);
        }
      }
    } catch (err) {
      logger.error({ err }, 'poll failed; retrying in 3s');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  logger.info('stopping');
  await db.close();
  process.exit(0);
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
