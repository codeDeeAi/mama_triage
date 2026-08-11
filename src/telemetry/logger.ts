/**
 * Structured logger.
 *
 * Redaction is configured at the logger level rather than left to call sites: a message
 * body or phone number must not reach the logs even if some future handler passes the
 * wrong object. This is a defence-in-depth complement to src/privacy/redact.ts, not a
 * replacement for it.
 */

import pino from 'pino';

/**
 * Paths scrubbed from every log record. Phone numbers and message bodies are the two
 * things that must never appear in Cloud Logging.
 */
const REDACT_PATHS = [
  'phone',
  'from',
  'waId',
  'wa_id',
  'body',
  'text',
  'message',
  'messages',
  '*.phone',
  '*.from',
  '*.waId',
  '*.body',
  '*.text',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'config.whatsapp.token',
  'config.whatsapp.appSecret',
  'config.llm.apiKey',
  'config.rag.voyageApiKey',
  'config.privacy.phoneHashPepper',
];

export function createLogger(level: string, pretty: boolean): pino.Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Cloud Logging reads `severity`, not pino's numeric `level`.
    formatters: {
      level(label) {
        return { severity: label.toUpperCase(), level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

export type Logger = pino.Logger;

export const REDACTED_PATHS: readonly string[] = REDACT_PATHS;
