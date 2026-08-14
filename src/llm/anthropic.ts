/**
 * Anthropic Messages API client.
 *
 * Narrow wrapper over the SDK exposing exactly one operation — "call a tool and give me
 * its validated input" — because that is the only shape this system uses. Structured tool
 * output is what makes the triage result scorable; free prose could not be evaluated.
 *
 * Adds a circuit breaker so that a sustained outage produces the static danger-sign
 * fallback immediately rather than fifteen seconds of timeout per message.
 */

import Anthropic from '@anthropic-ai/sdk';

export class LlmError extends Error {
  override readonly name = 'LlmError';
  constructor(
    message: string,
    readonly kind:
      | 'timeout'
      | 'api_error'
      | 'no_tool_use'
      | 'circuit_open'
      | 'invalid_output',
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export interface ToolCallRequest {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens: number;
  /** Cache the system prompt: it is long, static, and sent on every turn. */
  cacheSystemPrompt?: boolean;
}

export interface ToolCallResult {
  /** Raw tool input, still to be schema-validated by the caller. */
  input: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason: string | null;
  /**
   * The model that actually answered.
   *
   * Reported rather than assumed, because a fallback provider may have served the
   * request. Every outcome row records this, so an evaluation can always say which model
   * produced a given decision — two models reported as one figure would not describe any
   * system that exists.
   */
  model: string;
}

/** Minimal surface used from the SDK, so tests can supply a double. */
export interface MessagesApi {
  create(body: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

interface AnthropicResponse {
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  threshold?: number;
  /** How long the circuit stays open, in milliseconds. */
  resetMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly resetMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.resetMs = opts.resetMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.resetMs) {
      // Half-open: allow one trial call through.
      this.openedAt = null;
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  get state(): 'closed' | 'open' {
    return this.isOpen ? 'open' : 'closed';
  }
}

export interface AnthropicClientOptions {
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  messages?: MessagesApi;
  breaker?: CircuitBreaker;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AnthropicClient {
  private readonly messages: MessagesApi;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly breaker: CircuitBreaker;

  constructor(opts: AnthropicClientOptions = {}) {
    this.messages =
      opts.messages ??
      (new Anthropic({ apiKey: opts.apiKey ?? '' }).messages as unknown as MessagesApi);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.breaker = opts.breaker ?? new CircuitBreaker();
  }

  async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
    if (this.breaker.isOpen) {
      throw new LlmError('circuit breaker is open', 'circuit_open', false);
    }

    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model: req.model,
          max_tokens: req.maxTokens,
          // Deterministic output. Mandatory: an evaluation whose results change between
          // runs of the same scenario cannot be reported.
          temperature: 0,
          system: req.cacheSystemPrompt
            ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
            : req.system,
          tools: [
            {
              name: req.toolName,
              description: req.toolDescription,
              input_schema: req.toolSchema,
            },
          ],
          // Force the tool: the model must not answer in prose.
          tool_choice: { type: 'tool', name: req.toolName },
          messages: req.messages,
        };

        const res = (await this.messages.create(body, {
          timeout: this.timeoutMs,
        })) as AnthropicResponse;

        const toolUse = (res.content ?? []).find(
          (b) => b.type === 'tool_use' && b.name === req.toolName,
        );

        if (!toolUse || toolUse.input === undefined) {
          throw new LlmError(
            `model did not call ${req.toolName} (stop_reason: ${res.stop_reason ?? 'unknown'})`,
            'no_tool_use',
            true,
          );
        }

        this.breaker.recordSuccess();
        return {
          input: toolUse.input,
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          latencyMs: Date.now() - started,
          stopReason: res.stop_reason ?? null,
          model: req.model,
        };
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) break;
        if (attempt < this.maxRetries) await this.sleep(2 ** attempt * 400);
      }
    }

    this.breaker.recordFailure();
    throw toLlmError(lastError);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LlmError) return err.retryable;
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  // Network-level failure, or a timeout. Both are worth one more attempt.
  return true;
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);

  if (/timeout|aborted/i.test(message)) {
    return new LlmError(`LLM request timed out: ${message}`, 'timeout');
  }
  return new LlmError(
    `LLM request failed${status ? ` (${status})` : ''}: ${message}`,
    'api_error',
  );
}
