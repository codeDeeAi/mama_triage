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
    expect(cfg.whatsapp.appSecret).toBe('app-secret');
  });

  it('applies documented defaults', () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.llm.model).toBe('claude-sonnet-5');
    expect(cfg.llm.safetyModel).toBe('claude-haiku-4-5-20251001');
    expect(cfg.llm.timeoutMs).toBe(15000);
    expect(cfg.rag.topK).toBe(5);
    expect(cfg.behaviour.sessionTtlMinutes).toBe(60);
    expect(cfg.behaviour.promptVersion).toBe('triage.v1');
  });

  it('coerces numeric strings to numbers', () => {
    const cfg = parseConfig({ ...validEnv(), PORT: '3000', RETRIEVAL_TOP_K: '8' });
    expect(cfg.port).toBe(3000);
    expect(cfg.rag.topK).toBe(8);
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
    'WHATSAPP_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'ANTHROPIC_API_KEY',
    'VOYAGE_API_KEY',
    'PHONE_HASH_PEPPER',
  ])('refuses to start without %s', (key) => {
    const env = validEnv();
    delete env[key];
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(new RegExp(key));
  });

  it('names the security consequence for the webhook secret', () => {
    const env = validEnv();
    delete env.WHATSAPP_APP_SECRET;
    expect(() => parseConfig(env)).toThrow(/unauthenticated/i);
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
    delete env.ANTHROPIC_API_KEY;
    delete env.VOYAGE_API_KEY;

    let message = '';
    try {
      parseConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).toMatch(/VOYAGE_API_KEY/);
    expect(message).toMatch(/3 problems/);
  });

  it('uses the singular form for a single problem', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => parseConfig(env)).toThrow(/1 problem\b/);
  });
});
