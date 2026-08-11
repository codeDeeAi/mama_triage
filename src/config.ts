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

  // WhatsApp Business Cloud API
  WHATSAPP_TOKEN: requiredString('WHATSAPP_TOKEN is required'),
  WHATSAPP_PHONE_NUMBER_ID: requiredString('WHATSAPP_PHONE_NUMBER_ID is required'),
  WHATSAPP_VERIFY_TOKEN: requiredString('WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: requiredString(
    'WHATSAPP_APP_SECRET is required — without it the webhook is unauthenticated',
  ),

  // Anthropic
  ANTHROPIC_API_KEY: requiredString('ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  SAFETY_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  LLM_TIMEOUT_MS: intString('LLM_TIMEOUT_MS').default('15000'),
  LLM_MAX_TOKENS: intString('LLM_MAX_TOKENS').default('1500'),

  // RAG
  VOYAGE_API_KEY: requiredString('VOYAGE_API_KEY is required'),
  EMBEDDING_MODEL: z.string().min(1).default('voyage-3'),
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
  whatsapp: {
    token: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
  };
  llm: {
    apiKey: string;
    model: string;
    safetyModel: string;
    timeoutMs: number;
    maxTokens: number;
  };
  rag: {
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
  return {
    env: c.NODE_ENV,
    isProduction: c.NODE_ENV === 'production',
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    databaseUrl: c.DATABASE_URL,
    whatsapp: {
      token: c.WHATSAPP_TOKEN,
      phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: c.WHATSAPP_VERIFY_TOKEN,
      appSecret: c.WHATSAPP_APP_SECRET,
    },
    llm: {
      apiKey: c.ANTHROPIC_API_KEY,
      model: c.ANTHROPIC_MODEL,
      safetyModel: c.SAFETY_MODEL,
      timeoutMs: c.LLM_TIMEOUT_MS,
      maxTokens: c.LLM_MAX_TOKENS,
    },
    rag: {
      voyageApiKey: c.VOYAGE_API_KEY,
      embeddingModel: c.EMBEDDING_MODEL,
      chromaPath: c.CHROMA_PATH,
      topK: c.RETRIEVAL_TOP_K,
    },
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
