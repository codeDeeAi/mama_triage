import { LlmError } from '../../../src/llm/anthropic';
import { DeepSeekClient } from '../../../src/llm/deepseek';

const REQ = {
  model: 'ignored-primary-name',
  system: 'you are a triage assistant',
  messages: [{ role: 'user' as const, content: 'baby not feeding' }],
  toolName: 'record_triage',
  toolDescription: 'Record the assessment',
  toolSchema: { type: 'object', properties: { urgency: { type: 'string' } } },
  maxTokens: 500,
  cacheSystemPrompt: true,
};

function fakeFetch(res: { status: number; body?: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body ?? {},
      text: async () => JSON.stringify(res.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function toolCall(args: unknown) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ function: { name: 'record_triage', arguments: JSON.stringify(args) } }] },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  };
}

function client(fetchImpl: typeof fetch) {
  return new DeepSeekClient({ apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl });
}

describe('DeepSeekClient — request shape', () => {
  it('forces the tool call, because prose cannot be validated or cited', async () => {
    const f = fakeFetch({ status: 200, body: toolCall({ urgency: 'self_care' }) });
    await client(f.impl).callTool(REQ);

    expect(f.calls[0]?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'record_triage' },
    });
    expect(f.calls[0]?.tools).toHaveLength(1);
  });

  it('sends the system prompt as a system message and uses its own model name', async () => {
    const f = fakeFetch({ status: 200, body: toolCall({ urgency: 'self_care' }) });
    const res = await client(f.impl).callTool(REQ);

    const messages = f.calls[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: REQ.system });
    // The primary's model name is meaningless to this provider.
    expect(f.calls[0]?.model).toBe('deepseek-chat');
    expect(res.model).toBe('deepseek-chat');
  });

  it('parses the tool arguments and reports usage', async () => {
    const f = fakeFetch({ status: 200, body: toolCall({ urgency: 'emergency' }) });
    const res = await client(f.impl).callTool(REQ);

    expect(res.input).toEqual({ urgency: 'emergency' });
    expect(res.inputTokens).toBe(120);
    expect(res.outputTokens).toBe(40);
  });
});

describe('DeepSeekClient — failures', () => {
  it('classifies 5xx as the provider being unavailable, so a caller may retry', async () => {
    const f = fakeFetch({ status: 503 });
    await expect(client(f.impl).callTool(REQ)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'api_error',
      retryable: true,
    });
  });

  it('classifies 400 as a bad request, which retrying cannot fix', async () => {
    const f = fakeFetch({ status: 400, body: { error: 'bad schema' } });
    await expect(client(f.impl).callTool(REQ)).rejects.toMatchObject({
      kind: 'invalid_output',
      retryable: false,
    });
  });

  it.each([401, 402, 403])(
    'classifies %d as the provider declining, not as a bad request',
    async (status) => {
      // An unpaid balance returns 402. Calling that `invalid_output` would stop it
      // falling through to a standby, stranding every assessment on a billing problem
      // the other provider could have covered.
      const f = fakeFetch({ status, body: { error: { message: 'Insufficient Balance' } } });
      await expect(client(f.impl).callTool(REQ)).rejects.toMatchObject({
        kind: 'api_error',
        // Retrying the identical request will not pay the bill.
        retryable: false,
      });
    },
  );

  it('rejects a response with no tool call — there is nothing to validate', async () => {
    const f = fakeFetch({
      status: 200,
      body: { choices: [{ message: { content: 'I think she is fine' } }] },
    });
    await expect(client(f.impl).callTool(REQ)).rejects.toThrow(/no tool call/);
  });

  it('rejects truncated arguments rather than throwing a parse error', async () => {
    // A response cut short mid-JSON must surface as invalid output, so the caller retries
    // once and then falls back, rather than crashing the turn.
    const f = fakeFetch({
      status: 200,
      body: {
        choices: [
          { message: { tool_calls: [{ function: { arguments: '{"urgency":"emerg' } }] } },
        ],
      },
    });
    const err = await client(f.impl).callTool(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('invalid_output');
  });
});
