/**
 * DeepSeek client — a standby for when the primary provider cannot serve a request.
 *
 * DeepSeek exposes an OpenAI-compatible API, so the same tool-calling contract the triage
 * prompt depends on is available: a single function the model must call, with a JSON
 * schema it must satisfy. That matters more than it sounds. The whole design rests on the
 * model returning structured, citable output rather than prose, and a provider that could
 * only return free text could not stand in at all.
 *
 * Implemented with `fetch` rather than the OpenAI SDK: one dependency instead of one more,
 * and the transport stays injectable for tests.
 *
 * What this does NOT change is what happens to the answer. A decision from here goes
 * through the same schema validation, the same citation check against the chunks actually
 * retrieved, the same deterministic red-flag scan and the same urgency ratchet as one from
 * the primary. A weaker model can produce a worse assessment; it cannot produce a less
 * safe one.
 */

import { LlmError, type ToolCallRequest, type ToolCallResult } from './anthropic';
import type { ToolCallClient } from './client';

export interface DeepSeekClientOptions {
  apiKey: string;
  /** Defaults to the public endpoint. */
  baseUrl?: string;
  /** Overrides the model named in the request — the primary's name means nothing here. */
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class DeepSeekClient implements ToolCallClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          // The system prompt is a message with role "system" here rather than a separate
          // field. There is no prompt caching, so cacheSystemPrompt is ignored: it is an
          // optimisation, and a standby path that is slightly more expensive per call is
          // not worth complicating.
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          tools: [
            {
              type: 'function',
              function: {
                name: req.toolName,
                description: req.toolDescription,
                parameters: req.toolSchema,
              },
            },
          ],
          // Force the call rather than letting the model choose to answer in prose.
          // Unstructured output cannot be validated or cited, so it is unusable here.
          tool_choice: { type: 'function', function: { name: req.toolName } },
          max_tokens: req.maxTokens,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 401/402/403 are the provider declining to serve — a revoked key, an unpaid
        // balance, a blocked account. They say nothing about the request, so they belong
        // with timeouts and 5xx rather than with a malformed body. Getting this wrong
        // matters when this client is the primary: `invalid_output` does not fall through
        // to a standby, so an unpaid balance would strand every assessment instead of
        // being covered by the other provider. Only 400 and 422 mean the request itself.
        const declined =
          res.status === 401 ||
          res.status === 402 ||
          res.status === 403 ||
          res.status === 429 ||
          res.status >= 500;
        throw new LlmError(
          `DeepSeek request failed (${res.status}): ${detail.slice(0, 200)}`,
          declined ? 'api_error' : 'invalid_output',
          // Retrying the same request helps for rate limits and server errors only.
          res.status === 429 || res.status >= 500,
        );
      }

      const body = (await res.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      const raw = choice?.message?.tool_calls?.[0]?.function?.arguments;

      if (typeof raw !== 'string') {
        throw new LlmError(
          'DeepSeek returned no tool call, so there is nothing to validate',
          'invalid_output',
        );
      }

      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch {
        // Arguments arrive as a JSON string, and a truncated response yields invalid
        // JSON. Treated as invalid output rather than a crash: the caller retries once
        // and then falls back, which is the right answer either way.
        throw new LlmError(
          'DeepSeek returned tool arguments that are not valid JSON',
          'invalid_output',
        );
      }

      return {
        input,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
        stopReason: choice?.finish_reason ?? null,
        model: this.model,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LlmError(`DeepSeek request timed out after ${this.timeoutMs}ms`, 'timeout');
      }
      throw new LlmError(
        `DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}`,
        'api_error',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
