/**
 * Environment configuration.
 *
 * Every value is parsed and validated at boot. If anything required is missing or
 * malformed the process exits non-zero with a list of every problem found — not just the
 * first — so a misconfigured deployment is fixed in one pass.
 *
 * A triage service must never start half-configured: a missing PHONE_HASH_PEPPER would
 * silently weaken anonymisation, and a missing WHATSAPP_APP_SECRET would leave the
 * webhook open to anyone. Both are fatal here rather than discovered in production.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/** Coerce a decimal string to an integer, rejecting anything else. */
const intString = (name: string) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a whole number`)
    .transform(Number);

/**
 * A required string carrying the same message whether the variable is absent or empty.
 *
 * Zod reports a generic "Required" for a missing key and ignores the `.min(1)` message,
 * which would hide the explanation in the commonest failure mode — the variable simply
 * not being set.
 */
const requiredString = (message: string) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .min(1, message);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intString('PORT').default('8080'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: requiredString('DATABASE_URL is required'),

  // WhatsApp Business Cloud API. Optional as a group: a deployment may run Telegram
  // only. Cross-field validation below requires at least one channel to be configured.
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  // Telegram Bot API. TELEGRAM_WEBHOOK_SECRET is the shared secret Telegram echoes on
  // every update; without it the webhook is unauthenticated.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),

  // Anthropic. Optional: without it the deterministic safety layer, consent flow and
  // pathway selection still run, and assessment is disabled rather than the service
  // refusing to start. That makes the safety-critical paths testable on a real handset
  // before any LLM credentials exist.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  SAFETY_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  LLM_TIMEOUT_MS: intString('LLM_TIMEOUT_MS').default('15000'),
  LLM_MAX_TOKENS: intString('LLM_MAX_TOKENS').default('1500'),

  // Standby provider, tried only when the primary cannot answer. Optional: without it a
  // primary outage means the static fallback, which is safe but helps a mother far less
  // than an assessment does.
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().min(1).default('deepseek-chat'),

  // RAG
  // Optional for the same reason as ANTHROPIC_API_KEY — both are needed for assessment,
  // neither for the safety layer.
  VOYAGE_API_KEY: z.string().optional(),
  // voyage-4-lite rather than voyage-3: the 4-series carries a free token allowance that
  // the previous generation is excluded from, and is faster with a longer context window.
  // The model name is recorded in the index and a mismatch forces a rebuild — vectors
  // from two different models are not comparable, so this cannot be changed in place.
  EMBEDDING_MODEL: z.string().min(1).default('voyage-4-lite'),
  CHROMA_PATH: z.string().min(1).default('./knowledge/index'),
  RETRIEVAL_TOP_K: intString('RETRIEVAL_TOP_K').default('5'),

  // Privacy. 32 bytes hex = 64 chars; anything shorter materially weakens the HMAC.
  PHONE_HASH_PEPPER: z
    .string({
      required_error:
        'PHONE_HASH_PEPPER is required — without it phone numbers cannot be anonymised',
      invalid_type_error: 'PHONE_HASH_PEPPER must be a string',
    })
    .min(32, 'PHONE_HASH_PEPPER must be at least 32 characters (openssl rand -hex 32)'),

  // Behaviour
  SESSION_TTL_MINUTES: intString('SESSION_TTL_MINUTES').default('60'),
  PROMPT_VERSION: z.string().min(1).default('triage.v1'),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config {
  env: RawConfig['NODE_ENV'];
  isProduction: boolean;
  port: number;
  logLevel: RawConfig['LOG_LEVEL'];
  databaseUrl: string;
  /**
   * Configured channels. At least one is required.
   *
   * A deployment may run WhatsApp only, Telegram only, or both — the mother chooses at
   * registration. Absent channels are `undefined` rather than blank strings, so a
   * half-configured channel cannot start and then fail on first message.
   */
  whatsapp?: {
    token: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
  };
  telegram?: {
    botToken: string;
    webhookSecret: string;
    /** Used to build the t.me deep link shown at registration. */
    botUsername?: string;
  };
  /**
   * Assessment services. Absent when the LLM or embedding credentials are not
   * configured, in which case the deterministic safety layer still runs and the
   * assessment stage tells the mother it is unavailable.
   */
  llm?: {
    apiKey: string;
    model: string;
    safetyModel: string;
    timeoutMs: number;
    maxTokens: number;
  };
  /** Standby provider, used only when the primary cannot answer. */
  fallbackLlm?: {
    apiKey: string;
    model: string;
  };
  rag?: {
    voyageApiKey: string;
    embeddingModel: string;
    chromaPath: string;
    topK: number;
  };
  privacy: { phoneHashPepper: string };
  behaviour: { sessionTtlMinutes: number; promptVersion: string };
}

/**
 * Parse configuration from an environment object.
 *
 * Exported separately from the singleton so tests can exercise validation without
 * mutating `process.env`.
 *
 * @throws {ConfigError} listing every validation failure.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  - ${key}: ${issue.message}`;
    });
    throw new ConfigError(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.join('\n'),
    );
  }

  const c = result.data;

  // A channel is all-or-nothing: partial credentials would start a service that fails on
  // the first message rather than at boot.
  const whatsappKeys = [
    c.WHATSAPP_TOKEN,
    c.WHATSAPP_PHONE_NUMBER_ID,
    c.WHATSAPP_VERIFY_TOKEN,
    c.WHATSAPP_APP_SECRET,
  ];
  const whatsappSet = whatsappKeys.filter(Boolean).length;
  if (whatsappSet > 0 && whatsappSet < whatsappKeys.length) {
    throw new ConfigError(
      'Invalid configuration (1 problem):\n' +
        '  - WhatsApp is partially configured. Set all of WHATSAPP_TOKEN, ' +
        'WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET, or ' +
        'none of them.' +
        (c.WHATSAPP_APP_SECRET
          ? ''
          : ' WHATSAPP_APP_SECRET in particular is missing — without it the webhook is ' +
            'unauthenticated and anyone who learns the URL can drive the triage engine.'),
    );
  }

  const telegramKeys = [c.TELEGRAM_BOT_TOKEN, c.TELEGRAM_WEBHOOK_SECRET];
  const telegramSet = telegramKeys.filter(Boolean).length;
  if (telegramSet > 0 && telegramSet < telegramKeys.length) {
    throw new ConfigError(
      'Invalid configuration (1 problem):\n' +
        '  - Telegram is partially configured. Set both TELEGRAM_BOT_TOKEN and ' +
        'TELEGRAM_WEBHOOK_SECRET, or neither. Without the webhook secret the endpoint ' +
        'is unauthenticated.',
    );
  }

  if (whatsappSet === 0 && telegramSet === 0) {
    throw new ConfigError(
      'Invalid configuration (1 problem):\n' +
        '  - No messaging channel configured. Set the WHATSAPP_* variables, the ' +
        'TELEGRAM_* variables, or both. A triage service with no channel cannot ' +
        'receive a single message.',
    );
  }

  return {
    env: c.NODE_ENV,
    isProduction: c.NODE_ENV === 'production',
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    databaseUrl: c.DATABASE_URL,
    ...(whatsappSet > 0
      ? {
          whatsapp: {
            token: c.WHATSAPP_TOKEN as string,
            phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID as string,
            verifyToken: c.WHATSAPP_VERIFY_TOKEN as string,
            appSecret: c.WHATSAPP_APP_SECRET as string,
          },
        }
      : {}),
    ...(telegramSet > 0
      ? {
          telegram: {
            botToken: c.TELEGRAM_BOT_TOKEN as string,
            webhookSecret: c.TELEGRAM_WEBHOOK_SECRET as string,
            ...(c.TELEGRAM_BOT_USERNAME ? { botUsername: c.TELEGRAM_BOT_USERNAME } : {}),
          },
        }
      : {}),
    ...(c.ANTHROPIC_API_KEY
      ? {
          llm: {
            apiKey: c.ANTHROPIC_API_KEY,
            model: c.ANTHROPIC_MODEL,
            safetyModel: c.SAFETY_MODEL,
            timeoutMs: c.LLM_TIMEOUT_MS,
            maxTokens: c.LLM_MAX_TOKENS,
          },
        }
      : {}),
    ...(c.DEEPSEEK_API_KEY
      ? { fallbackLlm: { apiKey: c.DEEPSEEK_API_KEY, model: c.DEEPSEEK_MODEL } }
      : {}),
    ...(c.VOYAGE_API_KEY
      ? {
          rag: {
            voyageApiKey: c.VOYAGE_API_KEY,
            embeddingModel: c.EMBEDDING_MODEL,
            chromaPath: c.CHROMA_PATH,
            topK: c.RETRIEVAL_TOP_K,
          },
        }
      : {}),
    privacy: { phoneHashPepper: c.PHONE_HASH_PEPPER },
    behaviour: {
      sessionTtlMinutes: c.SESSION_TTL_MINUTES,
      promptVersion: c.PROMPT_VERSION,
    },
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

let cached: Config | undefined;

/**
 * The process-wide configuration singleton.
 *
 * Call once at startup. Exits the process on failure rather than throwing into an
 * unhandled rejection, so the failure is legible in Cloud Run logs.
 */
export function getConfig(): Config {
  if (cached) return cached;
  try {
    cached = parseConfig();
    return cached;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deliberate: this runs before the logger exists, and the message must reach the
    // container log verbatim.
    process.stderr.write(`\nFATAL: ${message}\n\nSee .env.example for the full contract.\n\n`);
    process.exit(1);
  }
}

/** Reset the singleton. Test-only. */
export function resetConfigCache(): void {
  cached = undefined;
}
