import { LlmError, type ToolCallRequest, type ToolCallResult } from '../../../src/llm/anthropic';
import type { ToolCallClient } from '../../../src/llm/client';
import { FallbackLlmClient, isAvailabilityFailure } from '../../../src/llm/fallbackClient';

const REQ = {
  model: 'primary-model',
  system: 'system',
  messages: [{ role: 'user' as const, content: 'hello' }],
  toolName: 'record_triage',
  toolDescription: 'desc',
  toolSchema: {},
  maxTokens: 100,
} satisfies ToolCallRequest;

function ok(model: string): ToolCallResult {
  return {
    input: { urgency: 'self_care' },
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    stopReason: 'tool_use',
    model,
  };
}

function client(impl: () => Promise<ToolCallResult>): ToolCallClient & { calls: number } {
  const c = {
    calls: 0,
    async callTool() {
      c.calls += 1;
      return impl();
    },
  };
  return c;
}

describe('isAvailabilityFailure', () => {
  it.each(['timeout', 'api_error', 'circuit_open'] as const)(
    'treats %s as the provider being unable to answer',
    (kind) => {
      expect(isAvailabilityFailure(new LlmError('x', kind))).toBe(true);
    },
  );

  it.each(['invalid_output', 'no_tool_use'] as const)(
    'treats %s as a problem with the request, not the provider',
    (kind) => {
      expect(isAvailabilityFailure(new LlmError('x', kind))).toBe(false);
    },
  );

  it('treats an unrecognised error as availability — it never reached a verdict', () => {
    expect(isAvailabilityFailure(new TypeError('socket hang up'))).toBe(true);
  });
});

describe('FallbackLlmClient', () => {
  it('does not touch the standby while the primary answers', async () => {
    const primary = client(async () => ok('primary-model'));
    const standby = client(async () => ok('standby-model'));
    const onFallback = jest.fn();

    const res = await new FallbackLlmClient({ primary, standby, onFallback }).callTool(REQ);

    expect(res.model).toBe('primary-model');
    expect(standby.calls).toBe(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('uses the standby when the primary cannot answer, and reports which model did', async () => {
    // An exhausted credit balance looks exactly like this, and is what motivated the
    // standby: the request is fine, the provider simply will not serve it.
    const primary = client(async () => {
      throw new LlmError('credit balance is too low', 'api_error');
    });
    const standby = client(async () => ok('standby-model'));
    const onFallback = jest.fn();

    const res = await new FallbackLlmClient({ primary, standby, onFallback }).callTool(REQ);

    expect(res.model).toBe('standby-model');
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'api_error', recovered: true }),
    );
  });

  it('does NOT fall back when the primary rejected the output', async () => {
    // Falling through here would route exactly the hardest cases — the ones the more
    // capable model already declined — to the weaker one. That is backwards for triage.
    const primary = client(async () => {
      throw new LlmError('failed the contract twice', 'invalid_output');
    });
    const standby = client(async () => ok('standby-model'));

    await expect(
      new FallbackLlmClient({ primary, standby }).callTool(REQ),
    ).rejects.toThrow(/failed the contract/);
    expect(standby.calls).toBe(0);
  });

  it('surfaces the standby failure, and records that it did not recover', async () => {
    const primary = client(async () => {
      throw new LlmError('primary down', 'timeout');
    });
    const standby = client(async () => {
      throw new LlmError('standby down too', 'api_error');
    });
    const onFallback = jest.fn();

    await expect(
      new FallbackLlmClient({ primary, standby, onFallback }).callTool(REQ),
    ).rejects.toThrow(/standby down too/);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ recovered: false, reason: 'timeout' }),
    );
  });
});
