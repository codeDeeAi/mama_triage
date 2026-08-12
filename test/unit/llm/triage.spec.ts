import { AnthropicClient, CircuitBreaker, LlmError, type MessagesApi } from '../../../src/llm/anthropic';
import { TriageService } from '../../../src/llm/triage';
import type { RetrievalOutcome } from '../../../src/rag/retrieve';
import type { Chunk } from '../../../src/rag/types';
import type { Slots, Urgency } from '../../../src/types';

const SYSTEM = 'test system prompt';

function chunk(id: string): Chunk {
  return {
    chunkId: id,
    documentSlug: 'who-imci',
    title: 'IMCI',
    publisher: 'WHO',
    section: 'Danger signs',
    pathway: 'neonatal',
    topics: [],
    tokenCount: 10,
    text: 'Not able to feed is a general danger sign.',
  };
}

function retrieval(ids: string[] = ['who-imci#1'], grounded = true): RetrievalOutcome {
  return {
    results: ids.map((id) => ({ chunk: chunk(id), score: 0.8 })),
    query: 'young infant not able to feed',
    grounded,
    topScore: grounded ? 0.8 : 0.1,
  };
}

function toolInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detected_language: 'en',
    pathway: 'neonatal',
    extracted_slots: {},
    red_flags: [],
    urgency: 'self_care',
    confidence: 'high',
    citations: [{ chunk_id: 'who-imci#1', claim: 'guidance' }],
    next_action: {
      type: 'conclude',
      meaning: 'Your baby seems well.',
      steps: ['Keep feeding on demand'],
      return_warnings: ['Return if the baby stops feeding'],
    },
    rationale: 'No danger signs elicited.',
    ...overrides,
  };
}

/** Anthropic API double returning a queue of tool inputs. */
function fakeApi(inputs: Array<Record<string, unknown> | Error>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const messages: MessagesApi = {
    async create(body) {
      calls.push(body);
      const next = inputs[Math.min(i, inputs.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return {
        content: [{ type: 'tool_use', name: 'record_triage', input: next }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: 'tool_use',
      };
    },
  };
  return { messages, calls, get callCount() { return i; } };
}

function service(
  api: MessagesApi,
  onAudit?: (e: string, d: Record<string, unknown>) => void,
): TriageService {
  return new TriageService({
    client: new AnthropicClient({ messages: api, maxRetries: 0, sleep: async () => undefined }),
    model: 'claude-sonnet-5',
    maxTokens: 1500,
    promptVersion: 'triage.v1',
    systemPrompt: SYSTEM,
    ...(onAudit ? { onAudit } : {}),
  });
}

function request(overrides: Partial<Parameters<TriageService['assess']>[0]> = {}) {
  return {
    pathway: 'neonatal' as const,
    knownSlots: {} as Slots,
    currentUrgency: null as Urgency | null,
    transcript: [{ role: 'user' as const, content: 'my baby seems fine' }],
    retrieval: retrieval(),
    ...overrides,
  };
}

describe('TriageService — request construction', () => {
  it('forces the tool and pins temperature to zero', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(request());

    const body = api.calls[0]!;
    expect(body.temperature).toBe(0);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_triage' });
  });

  it('caches the system prompt, which is long and static', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(request());
    expect(JSON.stringify(api.calls[0]!.system)).toContain('cache_control');
  });

  it('tells the model what is already established so it does not re-ask', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(
      request({ knownSlots: { feeding: 'reduced', age_days: 6 } }),
    );
    const content = JSON.stringify(api.calls[0]!.messages);
    expect(content).toContain('ALREADY ESTABLISHED');
    expect(content).toContain('feeding=reduced');
  });

  it('tells the model it may not de-escalate an assigned urgency', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(request({ currentUrgency: 'facility_visit' }));
    expect(JSON.stringify(api.calls[0]!.messages)).toContain('may not propose anything less urgent');
  });

  it('warns the model when retrieval was ungrounded', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(request({ retrieval: retrieval(['who-imci#1'], false) }));
    const content = JSON.stringify(api.calls[0]!.messages);
    expect(content).toContain('ungrounded');
    expect(content).toContain('more cautious');
  });

  it('includes the retrieved guidance with its chunk IDs', async () => {
    const api = fakeApi([toolInput()]);
    await service(api.messages).assess(request());
    expect(JSON.stringify(api.calls[0]!.messages)).toContain('who-imci#1');
  });
});

describe('TriageService — schema enforcement', () => {
  it('retries once on malformed output, then succeeds', async () => {
    const api = fakeApi([{ urgency: 'nonsense' }, toolInput()]);
    const decision = await service(api.messages).assess(request());
    expect(decision.urgency).toBe('self_care');
    expect(api.callCount).toBe(2);
  });

  it('tells the model what was wrong on the retry', async () => {
    const api = fakeApi([{ urgency: 'nonsense' }, toolInput()]);
    await service(api.messages).assess(request());
    expect(JSON.stringify(api.calls[1]!.messages)).toContain('previous response was rejected');
  });

  it('gives up after two failures so the caller can send the fallback', async () => {
    const api = fakeApi([{ bad: true }]);
    await expect(service(api.messages).assess(request())).rejects.toThrow(LlmError);
    expect(api.callCount).toBe(2);
  });

  it('audits a schema rejection', async () => {
    const events: string[] = [];
    const api = fakeApi([{ bad: true }, toolInput()]);
    await service(api.messages, (e) => events.push(e)).assess(request());
    expect(events).toContain('LLM_SCHEMA_REJECTED');
  });
});

describe('TriageService — citation validation', () => {
  it('rejects a citation to a chunk the model was never shown', async () => {
    // A fabricated citation means the model invented the support for a clinical claim.
    const events: string[] = [];
    const api = fakeApi([
      toolInput({ citations: [{ chunk_id: 'who-imci#999', claim: 'invented' }] }),
      toolInput(),
    ]);

    const decision = await service(api.messages, (e) => events.push(e)).assess(request());
    expect(events).toContain('CITATION_REJECTED');
    expect(decision.citations[0]?.chunk_id).toBe('who-imci#1');
  });

  it('fails over when the model fabricates citations twice', async () => {
    const api = fakeApi([toolInput({ citations: [{ chunk_id: 'fake#1', claim: 'x' }] })]);
    await expect(service(api.messages).assess(request())).rejects.toThrow(/contract twice/);
  });

  it('skips citation validation when retrieval returned nothing to cite', async () => {
    // There is no valid chunk to cite; the ungrounded flag carries that signal instead.
    const api = fakeApi([toolInput({ citations: [{ chunk_id: 'none', claim: 'x' }] })]);
    const decision = await service(api.messages).assess(
      request({ retrieval: { results: [], query: 'q', grounded: false, topScore: 0 } }),
    );
    expect(decision.ungrounded).toBe(true);
  });
});

describe('TriageService — deterministic rules override the model', () => {
  it('raises urgency when a slot fires a red flag the model ignored', async () => {
    // The model says self_care while reporting the baby cannot feed. The rules win.
    const events: string[] = [];
    const api = fakeApi([
      toolInput({ urgency: 'self_care', extracted_slots: { feeding: 'unable_to_feed' } }),
    ]);

    const decision = await service(api.messages, (e) => events.push(e)).assess(request());

    expect(decision.urgencyLlm).toBe('self_care');
    expect(decision.urgencyRules).toBe('emergency');
    expect(decision.urgency).toBe('emergency');
    expect(decision.escalatedBy).toBe('rules');
    expect(events).toContain('RULES_ESCALATED');
  });

  it('records the red flags that fired', async () => {
    const api = fakeApi([toolInput({ extracted_slots: { feeding: 'unable_to_feed' } })]);
    const decision = await service(api.messages).assess(request());
    expect(decision.redFlags.map((f) => f.id)).toContain('NEO_NOT_FEEDING');
  });

  it('leaves the model alone when the rules agree', async () => {
    const api = fakeApi([toolInput({ urgency: 'emergency', extracted_slots: { feeding: 'unable_to_feed' } })]);
    const decision = await service(api.messages).assess(request());
    expect(decision.urgency).toBe('emergency');
    expect(decision.escalatedBy).toBeNull();
  });

  it('re-runs the rules over slots accumulated across turns', async () => {
    // The danger sign was established two turns ago; the model does not repeat it.
    const api = fakeApi([toolInput({ urgency: 'self_care', extracted_slots: {} })]);
    const decision = await service(api.messages).assess(
      request({ knownSlots: { feeding: 'unable_to_feed' } }),
    );
    expect(decision.urgency).toBe('emergency');
  });

  it('never lets the rules lower urgency', async () => {
    const api = fakeApi([toolInput({ urgency: 'emergency', extracted_slots: { cord_appearance: 'red_or_discharging' } })]);
    const decision = await service(api.messages).assess(request());
    expect(decision.urgencyRules).toBe('facility_visit');
    expect(decision.urgency).toBe('emergency');
  });
});

describe('TriageService — low-confidence promotion', () => {
  it('promotes an uncertain self_care to facility_visit', async () => {
    // The failure mode that kills: an uncertain "stay home" where the nearest facility
    // may be hours away.
    const events: string[] = [];
    const api = fakeApi([toolInput({ urgency: 'self_care', confidence: 'low' })]);

    const decision = await service(api.messages, (e) => events.push(e)).assess(request());

    expect(decision.urgency).toBe('facility_visit');
    expect(decision.escalatedBy).toBe('low_confidence');
    expect(events).toContain('LOW_CONFIDENCE_PROMOTED');
  });

  it('leaves a confident self_care alone', async () => {
    const api = fakeApi([toolInput({ urgency: 'self_care', confidence: 'high' })]);
    expect((await service(api.messages).assess(request())).urgency).toBe('self_care');
  });

  it('does not promote a low-confidence facility_visit to emergency', async () => {
    const api = fakeApi([toolInput({ urgency: 'facility_visit', confidence: 'low' })]);
    expect((await service(api.messages).assess(request())).urgency).toBe('facility_visit');
  });
});

describe('TriageService — session ratchet', () => {
  it('blocks a de-escalation and records it as a finding', async () => {
    const events: string[] = [];
    const api = fakeApi([toolInput({ urgency: 'self_care' })]);

    const decision = await service(api.messages, (e) => events.push(e)).assess(
      request({ currentUrgency: 'emergency' }),
    );

    expect(decision.urgency).toBe('emergency');
    expect(decision.urgencyLlm).toBe('self_care');
    expect(events).toContain('RATCHET_BLOCKED_DOWNGRADE');
  });

  it('allows an escalation above the current level', async () => {
    const api = fakeApi([toolInput({ urgency: 'emergency' })]);
    const decision = await service(api.messages).assess(request({ currentUrgency: 'facility_visit' }));
    expect(decision.urgency).toBe('emergency');
  });
});

describe('TriageService — provenance', () => {
  it('records model, prompt version and token usage for reproducibility', async () => {
    const api = fakeApi([toolInput()]);
    const decision = await service(api.messages).assess(request());

    expect(decision.model).toBe('claude-sonnet-5');
    expect(decision.promptVersion).toBe('triage.v1');
    expect(decision.inputTokens).toBe(100);
    expect(decision.outputTokens).toBe(50);
  });

  it('merges extracted slots into the session state', async () => {
    const api = fakeApi([toolInput({ extracted_slots: { breathing: 'normal' } })]);
    const decision = await service(api.messages).assess(request({ knownSlots: { age_days: 6 } }));
    expect(decision.slots).toEqual({ age_days: 6, breathing: 'normal' });
  });
});

describe('AnthropicClient', () => {
  it('throws when the model answers in prose instead of calling the tool', async () => {
    const messages: MessagesApi = {
      async create() {
        return { content: [{ type: 'text' }], stop_reason: 'end_turn' };
      },
    };
    const client = new AnthropicClient({ messages, maxRetries: 0, sleep: async () => undefined });
    await expect(
      client.callTool({
        model: 'm', system: 's', messages: [], toolName: 'record_triage',
        toolDescription: 'd', toolSchema: {}, maxTokens: 100,
      }),
    ).rejects.toThrow(/did not call record_triage/);
  });

  it('retries a 500 and succeeds', async () => {
    let n = 0;
    const messages: MessagesApi = {
      async create() {
        n += 1;
        if (n === 1) throw Object.assign(new Error('server error'), { status: 500 });
        return { content: [{ type: 'tool_use', name: 't', input: { ok: true } }] };
      },
    };
    const client = new AnthropicClient({ messages, maxRetries: 2, sleep: async () => undefined });
    const res = await client.callTool({
      model: 'm', system: 's', messages: [], toolName: 't',
      toolDescription: 'd', toolSchema: {}, maxTokens: 100,
    });
    expect(res.input).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('does not retry a 400', async () => {
    let n = 0;
    const messages: MessagesApi = {
      async create() {
        n += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    };
    const client = new AnthropicClient({ messages, maxRetries: 3, sleep: async () => undefined });
    await expect(
      client.callTool({
        model: 'm', system: 's', messages: [], toolName: 't',
        toolDescription: 'd', toolSchema: {}, maxTokens: 100,
      }),
    ).rejects.toThrow(LlmError);
    expect(n).toBe(1);
  });

  it('classifies a timeout', async () => {
    const messages: MessagesApi = {
      async create() {
        throw new Error('Request timeout after 15000ms');
      },
    };
    const client = new AnthropicClient({ messages, maxRetries: 0, sleep: async () => undefined });
    await expect(
      client.callTool({
        model: 'm', system: 's', messages: [], toolName: 't',
        toolDescription: 'd', toolSchema: {}, maxTokens: 100,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
  });

  it('opens at the threshold', () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    expect(cb.state).toBe('open');
  });

  it('resets on success', () => {
    const cb = new CircuitBreaker({ threshold: 2 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
  });

  it('half-opens after the reset window', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ threshold: 1, resetMs: 500, now: () => now });
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    now += 600;
    expect(cb.isOpen).toBe(false); // one trial call allowed through
  });

  it('short-circuits a call while open, so the fallback is immediate', async () => {
    const breaker = new CircuitBreaker({ threshold: 1 });
    breaker.recordFailure();
    const client = new AnthropicClient({
      messages: { async create() { throw new Error('should not be called'); } },
      breaker,
    });
    await expect(
      client.callTool({
        model: 'm', system: 's', messages: [], toolName: 't',
        toolDescription: 'd', toolSchema: {}, maxTokens: 100,
      }),
    ).rejects.toMatchObject({ kind: 'circuit_open' });
  });
});
