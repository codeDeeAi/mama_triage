import { AnthropicClient, type MessagesApi } from '../../../src/llm/anthropic';
import { SafetyCheckService } from '../../../src/llm/safetyCheck';

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
        content: [{ type: 'tool_use', name: 'safety_verdict', input: next }],
        usage: { input_tokens: 40, output_tokens: 20 },
      };
    },
  };
  return { messages, calls };
}

function service(
  api: MessagesApi,
  onAudit?: (e: string, d: Record<string, unknown>) => void,
): SafetyCheckService {
  return new SafetyCheckService({
    client: new AnthropicClient({ messages: api, maxRetries: 0, sleep: async () => undefined }),
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: 'safety check prompt',
    ...(onAudit ? { onAudit } : {}),
  });
}

const transcript = [
  { role: 'user' as const, content: 'my baby is 6 days old and not sucking since morning' },
  { role: 'assistant' as const, content: 'How is the baby breathing?' },
];

describe('SafetyCheckService — agreement', () => {
  it('leaves the proposal unchanged when it agrees', async () => {
    const api = fakeApi([{ verdict: 'agree', reason: 'nothing missed' }]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'reduced feeding',
    });

    expect(result.urgency).toBe('facility_visit');
    expect(result.escalated).toBe(false);
    expect(result.failedOpen).toBe(false);
  });
});

describe('SafetyCheckService — escalation', () => {
  it('raises urgency when it catches something missed', async () => {
    const events: string[] = [];
    const api = fakeApi([
      {
        verdict: 'escalate',
        escalate_to: 'emergency',
        reason: 'a 6-day-old not feeding at all is a general danger sign',
      },
    ]);

    const result = await service(api.messages, (e) => events.push(e)).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'reduced feeding',
    });

    expect(result.urgency).toBe('emergency');
    expect(result.escalated).toBe(true);
    expect(result.reason).toContain('danger sign');
    expect(events).toContain('SAFETY_CHECK_ESCALATED');
  });

  it('escalates across two tiers', async () => {
    const api = fakeApi([{ verdict: 'escalate', escalate_to: 'emergency', reason: 'x' }]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'self_care',
      rationale: 'r',
    });
    expect(result.urgency).toBe('emergency');
  });
});

describe('SafetyCheckService — cannot de-escalate', () => {
  it('ignores an "escalation" to a lower tier', async () => {
    // The prompt forbids this, but the guarantee must not rest on the model obeying it.
    const events: string[] = [];
    const api = fakeApi([
      { verdict: 'escalate', escalate_to: 'self_care', reason: 'seems fine actually' },
    ]);

    const result = await service(api.messages, (e) => events.push(e)).check({
      transcript,
      proposed: 'emergency',
      rationale: 'r',
    });

    expect(result.urgency).toBe('emergency');
    expect(result.escalated).toBe(false);
    expect(events).toContain('SAFETY_CHECK_INVALID_ESCALATION');
  });

  it('ignores an "escalation" to the same tier', async () => {
    const api = fakeApi([
      { verdict: 'escalate', escalate_to: 'facility_visit', reason: 'same' },
    ]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'r',
    });
    expect(result.escalated).toBe(false);
  });

  it('holds the proposal when escalate_to is missing', async () => {
    const api = fakeApi([{ verdict: 'escalate', reason: 'vague' }]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'r',
    });
    // Schema rejects it, so the check fails open rather than guessing a target.
    expect(result.urgency).toBe('facility_visit');
    expect(result.failedOpen).toBe(true);
  });
});

describe('SafetyCheckService — fails open', () => {
  it('holds the primary decision when the API errors', async () => {
    // A broken safety net must not block a mother's assessment.
    const events: string[] = [];
    const api = fakeApi([new Error('network down')]);

    const result = await service(api.messages, (e) => events.push(e)).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'r',
    });

    expect(result.urgency).toBe('facility_visit');
    expect(result.failedOpen).toBe(true);
    expect(events).toContain('SAFETY_CHECK_FAILED');
  });

  it('holds the primary decision on malformed output', async () => {
    const api = fakeApi([{ nonsense: true }]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'emergency',
      rationale: 'r',
    });
    expect(result.urgency).toBe('emergency');
    expect(result.failedOpen).toBe(true);
  });

  it('audits every failure so the rate is visible, not silent', async () => {
    const events: Array<{ e: string; d: Record<string, unknown> }> = [];
    const api = fakeApi([new Error('boom')]);
    await service(api.messages, (e, d) => events.push({ e, d })).check({
      transcript,
      proposed: 'self_care',
      rationale: 'r',
    });
    expect(events[0]?.e).toBe('SAFETY_CHECK_FAILED');
    expect(String(events[0]?.d.reason)).toContain('boom');
  });
});

describe('SafetyCheckService — request construction', () => {
  it('sends the transcript, the proposal and the reasoning', async () => {
    const api = fakeApi([{ verdict: 'agree', reason: 'ok' }]);
    await service(api.messages).check({
      transcript,
      proposed: 'facility_visit',
      rationale: 'reduced feeding but alert',
    });

    const content = JSON.stringify(api.calls[0]!.messages);
    expect(content).toContain('not sucking since morning');
    expect(content).toContain('facility_visit');
    expect(content).toContain('reduced feeding but alert');
  });

  it('uses the cheap independent model', async () => {
    const api = fakeApi([{ verdict: 'agree', reason: 'ok' }]);
    await service(api.messages).check({ transcript, proposed: 'self_care', rationale: 'r' });
    expect(api.calls[0]!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('reports token usage so cost per triage can be measured', async () => {
    const api = fakeApi([{ verdict: 'agree', reason: 'ok' }]);
    const result = await service(api.messages).check({
      transcript,
      proposed: 'self_care',
      rationale: 'r',
    });
    expect(result.inputTokens).toBe(40);
    expect(result.outputTokens).toBe(20);
  });
});
