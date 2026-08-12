import { ConfigError, parseConfig } from '../../src/config';

/** A complete, valid environment. Individual tests remove or corrupt one key. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '8080',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://mama:mama@localhost:5433/mama_triage',
    WHATSAPP_TOKEN: 'wa-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_APP_SECRET: 'app-secret',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    VOYAGE_API_KEY: 'pa-test',
    PHONE_HASH_PEPPER: 'a'.repeat(64),
  };
}

describe('parseConfig — happy path', () => {
  it('accepts a complete environment', () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.port).toBe(8080);
    expect(cfg.databaseUrl).toContain('mama_triage');
    expect(cfg.whatsapp?.appSecret).toBe('app-secret');
  });

  it('applies documented defaults', () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.llm?.model).toBe('claude-sonnet-5');
    expect(cfg.llm?.safetyModel).toBe('claude-haiku-4-5-20251001');
    expect(cfg.llm?.timeoutMs).toBe(15000);
    expect(cfg.rag?.topK).toBe(5);
    expect(cfg.behaviour.sessionTtlMinutes).toBe(60);
    expect(cfg.behaviour.promptVersion).toBe('triage.v1');
  });

  it('coerces numeric strings to numbers', () => {
    const cfg = parseConfig({ ...validEnv(), PORT: '3000', RETRIEVAL_TOP_K: '8' });
    expect(cfg.port).toBe(3000);
    expect(cfg.rag?.topK).toBe(8);
    expect(typeof cfg.port).toBe('number');
  });

  it('derives isProduction', () => {
    expect(parseConfig({ ...validEnv(), NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(parseConfig(validEnv()).isProduction).toBe(false);
  });
});

describe('parseConfig — required secrets', () => {
  it.each([
    'DATABASE_URL',
    'PHONE_HASH_PEPPER',
  ])('refuses to start without %s', (key) => {
    const env = validEnv();
    delete env[key];
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(new RegExp(key));
  });

  it('names the security consequence when the webhook secret is missing', () => {
    const env = validEnv();
    delete env.WHATSAPP_APP_SECRET;
    expect(() => parseConfig(env)).toThrow(/unauthenticated/i);
    expect(() => parseConfig(env)).toThrow(/drive the triage engine/i);
  });
});

describe('parseConfig — validation', () => {
  it('rejects a pepper that is too short to be a real HMAC key', () => {
    expect(() => parseConfig({ ...validEnv(), PHONE_HASH_PEPPER: 'short' })).toThrow(
      /at least 32 characters/i,
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseConfig({ ...validEnv(), PORT: 'eighty-eighty' })).toThrow(
      /PORT must be a whole number/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseConfig({ ...validEnv(), NODE_ENV: 'staging' })).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseConfig({ ...validEnv(), LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });

  it('reports every problem at once, not just the first', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    delete env.PHONE_HASH_PEPPER;
    env.PORT = 'not-a-number';

    let message = '';
    try {
      parseConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PHONE_HASH_PEPPER/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/3 problems/);
  });

  it('uses the singular form for a single problem', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => parseConfig(env)).toThrow(/1 problem\b/);
  });
});

describe('messaging channels — WhatsApp, Telegram, or both', () => {
  const telegramOnly = (): NodeJS.ProcessEnv => {
    const env = validEnv();
    delete env.WHATSAPP_TOKEN;
    delete env.WHATSAPP_PHONE_NUMBER_ID;
    delete env.WHATSAPP_VERIFY_TOKEN;
    delete env.WHATSAPP_APP_SECRET;
    env.TELEGRAM_BOT_TOKEN = '123:ABC';
    env.TELEGRAM_WEBHOOK_SECRET = 'a-shared-secret';
    return env;
  };

  it('accepts Telegram alone', () => {
    const cfg = parseConfig(telegramOnly());
    expect(cfg.telegram?.botToken).toBe('123:ABC');
    expect(cfg.whatsapp).toBeUndefined();
  });

  it('accepts WhatsApp alone', () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.whatsapp).toBeDefined();
    expect(cfg.telegram).toBeUndefined();
  });

  it('accepts both, which is what a platform choice at registration needs', () => {
    const env = { ...validEnv(), TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_WEBHOOK_SECRET: 's' };
    const cfg = parseConfig(env);
    expect(cfg.whatsapp).toBeDefined();
    expect(cfg.telegram).toBeDefined();
  });

  it('refuses to start with no channel at all', () => {
    const env = telegramOnly();
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => parseConfig(env)).toThrow(/No messaging channel configured/i);
    expect(() => parseConfig(env)).toThrow(/cannot receive a single message/i);
  });

  it('rejects a partially configured Telegram channel', () => {
    // Half-configured would start and then fail on the first update. The webhook secret
    // is what authenticates the endpoint, so its absence is not a detail.
    const env = telegramOnly();
    delete env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => parseConfig(env)).toThrow(/Telegram is partially configured/i);
    expect(() => parseConfig(env)).toThrow(/unauthenticated/i);
  });

  it('carries the bot username for the registration deep link', () => {
    const cfg = parseConfig({ ...telegramOnly(), TELEGRAM_BOT_USERNAME: 'MamaTriageBot' });
    expect(cfg.telegram?.botUsername).toBe('MamaTriageBot');
  });
});

describe('assessment credentials are optional', () => {
  it('starts without LLM credentials, with assessment disabled', () => {
    // The deterministic safety layer, consent and pathway selection are what a mother
    // most needs, and they need no API key. Requiring one would make the safety-critical
    // paths untestable on a real handset until billing is set up.
    const env = validEnv();
    delete env.ANTHROPIC_API_KEY;
    delete env.VOYAGE_API_KEY;

    const cfg = parseConfig(env);
    expect(cfg.llm).toBeUndefined();
    expect(cfg.rag).toBeUndefined();
    expect(cfg.whatsapp).toBeDefined();
  });

  it('still requires the database and the privacy pepper', () => {
    const env = validEnv();
    delete env.ANTHROPIC_API_KEY;
    delete env.PHONE_HASH_PEPPER;
    expect(() => parseConfig(env)).toThrow(/PHONE_HASH_PEPPER/);
  });
});
