/**
 * Express application assembly.
 *
 * Middleware order is load-bearing:
 *
 *   /webhook  →  express.raw  →  verifySignature  →  route
 *   others    →  express.json →  route
 *
 * `express.raw` must be scoped to the webhook path and must run before any JSON parser,
 * or the raw bytes are consumed and the signature can never be verified. `verifySignature`
 * fails closed if it finds a non-Buffer body, so a future refactor that reorders this
 * returns 500 rather than silently accepting unauthenticated requests.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { verifySignature } from './middleware/verifySignature';
import { createWebhookRouter, type WebhookDeps } from './webhook.routes';
import { createAdminRouter, type AdminDeps } from './admin.routes';
import { createDemoRouter, type DemoDeps } from './demo.routes';
import { createTelegramRouter, type TelegramWebhookDeps } from './telegram.routes';
import { createRegisterRouter, type RegisterDeps } from './register.routes';
import { join } from 'node:path';
import type { Db } from '../db/pool';
import type { AuditRepository } from '../db/repositories/event.repo';
import type { Logger } from '../telemetry/logger';

export interface AppDeps extends WebhookDeps {
  appSecret: string;
  db: Db;
  audit: AuditRepository;
  version?: string;
  /** Admin/debug routes. Omit to disable them entirely. */
  admin?: Omit<AdminDeps, 'logger'>;
  /** Browser demonstration interface. Omit to disable it entirely. */
  demo?: Omit<DemoDeps, 'logger'>;
  /** False when no WhatsApp credentials are configured; the routes are then not mounted. */
  whatsappEnabled?: boolean;
  /** Telegram channel. Omit to run WhatsApp only. */
  telegram?: Pick<TelegramWebhookDeps, 'secretToken' | 'client' | 'handleMessage'>;
  /** Registration surface. Omit to disable it entirely. */
  register?: Omit<RegisterDeps, 'logger'>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');

  // --- webhook: raw body, then signature verification -------------------------------
  app.use(
    '/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req: Request, res: Response, next: NextFunction) => {
      // The GET handshake carries no body and no signature.
      if (req.method === 'GET') return next();
      return verifySignature(deps.appSecret, (reason) => {
        deps.logger.warn({ reason }, 'webhook request rejected');
        void deps.audit.record('WEBHOOK_REJECTED', { reason });
      })(req, res, next);
    },
  );

  if (deps.whatsappEnabled !== false) {
    app.use(createWebhookRouter(deps));
  }

  // --- everything else: JSON --------------------------------------------------------
  app.use(express.json({ limit: '256kb' }));

  // Telegram authenticates with a shared secret header rather than a body signature, so
  // it needs the parsed JSON body and mounts after the parser — unlike the WhatsApp
  // webhook, which must see raw bytes.
  if (deps.telegram) {
    app.use(
      createTelegramRouter({
        ...deps.telegram,
        events: deps.events,
        queue: deps.queue,
        logger: deps.logger,
        onReject: (reason) => {
          void deps.audit.record('WEBHOOK_REJECTED', { channel: 'telegram', reason });
        },
      }),
    );
  }

  /** Liveness: the process is up. Deliberately does not touch the database. */
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', version: deps.version ?? 'dev' });
  });

  /** Readiness: dependencies are reachable. Cloud Run uses this to gate traffic. */
  app.get('/readyz', async (_req: Request, res: Response) => {
    const dbOk = await deps.db.healthy();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ready' : 'degraded',
      checks: { database: dbOk ? 'ok' : 'unreachable' },
    });
  });

  if (deps.admin) {
    app.use(createAdminRouter({ ...deps.admin, logger: deps.logger }));
  }

  if (deps.register) {
    app.use(createRegisterRouter({ ...deps.register, logger: deps.logger }));
    app.use('/register', express.static(join(process.cwd(), 'public', 'register')));
  }

  if (deps.demo?.enabled) {
    app.use(createDemoRouter({ ...deps.demo, logger: deps.logger }));
    app.use('/demo', express.static(join(process.cwd(), 'public', 'demo')));
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // Express 4 identifies an error handler by its arity — `next` must stay in the
  // signature even though it is unused.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err }, 'unhandled request error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
