import { runAssessmentTurn, type AssessmentDeps } from '../../../src/orchestrator/assessment';
import { LlmError } from '../../../src/llm/anthropic';
import type { TriageDecision } from '../../../src/llm/triage';
import type { RetrievalOutcome } from '../../../src/rag/retrieve';
import type { SafetyCheckResult } from '../../../src/llm/safetyCheck';
import type { Language, Pathway, Slots, Urgency } from '../../../src/types';

const retrieval: RetrievalOutcome = {
  results: [
    {
      chunk: {
        chunkId: 'who-imci#1',
        documentSlug: 'who-imci',
        title: 'IMCI',
        publisher: 'WHO',
        section: 'Danger signs',
        pathway: 'neonatal',
        topics: [],
        tokenCount: 10,
        text: 'guidance',
      },
      score: 0.8,
    },
  ],
  query: 'q',
  grounded: true,
  topScore: 0.8,
};

function decision(o: {
  urgency?: Urgency;
  action?: Record<string, unknown>;
  slots?: Slots;
  language?: Language;
}): TriageDecision {
  const urgency = o.urgency ?? 'self_care';
  return {
    urgency,
    urgencyLlm: urgency,
    urgencyRules: null,
    escalatedBy: null,
    redFlags: [],
    slots: o.slots ?? {},
    citations: [{ chunk_id: 'who-imci#1', claim: 'c' }],
    model: 'claude-sonnet-5',
    promptVersion: 'triage.v1',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    ungrounded: false,
    result: {
      detected_language: o.language ?? 'en',
      pathway: 'neonatal',
      extracted_slots: o.slots ?? {},
      red_flags: [],
      urgency,
      confidence: 'high',
      citations: [{ chunk_id: 'who-imci#1', claim: 'c' }],
      rationale: 'reasoning',
      next_action: (o.action ?? {
        type: 'conclude',
        meaning: 'All seems well.',
        steps: ['Keep feeding'],
        return_warnings: ['Return if feeding stops'],
      }) as never,
    } as never,
  };
}

function deps(o: {
  decision?: TriageDecision;
  triageError?: unknown;
  retrievalError?: unknown;
  verdict?: Partial<SafetyCheckResult>;
  onAudit?: (e: string, d: Record<string, unknown>) => void;
}): AssessmentDeps {
  return {
    retriever: {
      retrieve: async () => {
        if (o.retrievalError) throw o.retrievalError;
        return retrieval;
      },
    } as never,
    triage: {
      assess: async () => {
        if (o.triageError) throw o.triageError;
        return o.decision ?? decision({});
      },
    } as never,
    safetyCheck: {
      check: async (input: { proposed: Urgency }): Promise<SafetyCheckResult> => ({
        urgency: input.proposed,
        escalated: false,
        reason: null,
        failedOpen: false,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        ...o.verdict,
      }),
    } as never,
    ...(o.onAudit ? { onAudit: o.onAudit } : {}),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    pathway: 'neonatal' as Pathway,
    language: 'en' as Language,
    knownSlots: {} as Slots,
    currentUrgency: null as Urgency | null,
    transcript: [{ role: 'user' as const, content: 'my baby is unwell' }],
    message: 'my baby is unwell',
    ...overrides,
  };
}

describe('runAssessmentTurn — happy path', () => {
  it('returns the rendered conclusion and completes the session', async () => {
    const out = await runAssessmentTurn(deps({}), input());
    expect(out.state).toBe('completed');
    expect(out.urgency).toBe('self_care');
    expect(out.messages[0]).toContain('CARE AT HOME');
    expect(out.decision).toBeDefined();
  });

  it('stays assessing while asking questions', async () => {
    const out = await runAssessmentTurn(
      deps({ decision: decision({ action: { type: 'ask', domain: 'breathing', question: 'How is the breathing?' } }) }),
      input(),
    );
    expect(out.state).toBe('assessing');
    expect(out.messages).toEqual(['How is the breathing?']);
  });

  it('escalates and ends on an emergency', async () => {
    const out = await runAssessmentTurn(deps({ decision: decision({ urgency: 'emergency' }) }), input());
    expect(out.state).toBe('escalated');
    expect(out.messages[0]).toContain('EMERGENCY');
  });

  it('returns the merged slots', async () => {
    const out = await runAssessmentTurn(
      deps({ decision: decision({ slots: { feeding: 'normal', breathing: 'normal' } }) }),
      input({ knownSlots: { age_days: 6 } }),
    );
    expect(out.slots).toMatchObject({ feeding: 'normal', breathing: 'normal' });
  });
});

describe('runAssessmentTurn — second-pass escalation', () => {
  it('applies the safety check escalation', async () => {
    const out = await runAssessmentTurn(
      deps({
        decision: decision({ urgency: 'self_care' }),
        verdict: { urgency: 'emergency', escalated: true, reason: 'missed danger sign' },
      }),
      input(),
    );

    expect(out.urgency).toBe('emergency');
    expect(out.safetyCheckEscalated).toBe(true);
    expect(out.state).toBe('escalated');
  });

  it('re-renders so the banner matches the escalated urgency', async () => {
    // Without re-rendering, the recorded urgency would say emergency while the mother
    // saw a green "care at home" banner.
    const out = await runAssessmentTurn(
      deps({
        decision: decision({ urgency: 'self_care' }),
        verdict: { urgency: 'emergency', escalated: true, reason: 'r' },
      }),
      input(),
    );

    expect(out.messages[0]).toContain('EMERGENCY');
    expect(out.messages[0]).not.toContain('CARE AT HOME');
    expect(out.messages[0]).toMatch(/nearest health facility now/i);
  });

  it('converts a pending question into an emergency message', async () => {
    const out = await runAssessmentTurn(
      deps({
        decision: decision({
          urgency: 'self_care',
          action: { type: 'ask', domain: 'jaundice', question: 'Is the baby yellow?' },
        }),
        verdict: { urgency: 'emergency', escalated: true, reason: 'r' },
      }),
      input(),
    );

    expect(out.messages[0]).toContain('EMERGENCY');
    expect(out.messages[0]).not.toContain('Is the baby yellow?');
  });

  it('records the escalation source on the decision', async () => {
    const out = await runAssessmentTurn(
      deps({
        decision: decision({ urgency: 'facility_visit' }),
        verdict: { urgency: 'emergency', escalated: true, reason: 'r' },
      }),
      input(),
    );
    expect(out.decision?.escalatedBy).toBe('safety_check');
  });

  it('never lets the safety check lower urgency', async () => {
    const out = await runAssessmentTurn(
      deps({
        decision: decision({ urgency: 'emergency' }),
        verdict: { urgency: 'self_care', escalated: false, reason: null },
      }),
      input(),
    );
    expect(out.urgency).toBe('emergency');
    expect(out.safetyCheckEscalated).toBe(false);
  });
});

describe('runAssessmentTurn — the system never goes quiet', () => {
  it.each([
    ['a timeout', new LlmError('timed out', 'timeout'), 'llm_timeout'],
    ['an open circuit', new LlmError('open', 'circuit_open'), 'circuit_open'],
    ['unusable output', new LlmError('bad', 'invalid_output'), 'llm_invalid_output'],
    ['an API error', new LlmError('500', 'api_error'), 'llm_unavailable'],
    ['an unexpected error', new Error('boom'), 'llm_unavailable'],
  ])('sends the static danger-sign fallback on %s', async (_label, error, reason) => {
    const out = await runAssessmentTurn(deps({ triageError: error }), input());

    expect(out.fallbackReason).toBe(reason);
    expect(out.messages[0]).toMatch(/not able to complete/i);
    expect(out.messages[0]).toMatch(/nearest health facility/i);
    // Ends safely rather than continuing to assess.
    expect(out.state).toBe('completed');
  });

  it('falls back when retrieval fails', async () => {
    const out = await runAssessmentTurn(
      deps({ retrievalError: new Error('embedding API down') }),
      input(),
    );
    expect(out.fallbackReason).toBe('retrieval_failed');
    expect(out.messages[0]).toMatch(/danger signs/i);
  });

  it('shows the danger signs for the active pathway', async () => {
    const out = await runAssessmentTurn(
      deps({ triageError: new LlmError('x', 'timeout') }),
      input({ pathway: 'maternal' }),
    );
    expect(out.messages[0]).toMatch(/soaking more than one pad/i);
    expect(out.messages[0]).not.toMatch(/unable to suck at the breast/i);
  });

  it('sends the fallback in Pidgin when that is the session language', async () => {
    const out = await runAssessmentTurn(
      deps({ triageError: new LlmError('x', 'timeout') }),
      input({ language: 'pcm' }),
    );
    expect(out.messages[0]).toMatch(/no fit finish/i);
    expect(out.messages[0]).toMatch(/health centre wey dey near you/i);
  });

  it('preserves the session urgency through a fallback', async () => {
    const out = await runAssessmentTurn(
      deps({ triageError: new LlmError('x', 'timeout') }),
      input({ currentUrgency: 'facility_visit' }),
    );
    expect(out.urgency).toBe('facility_visit');
  });

  it('audits the failover', async () => {
    const events: string[] = [];
    await runAssessmentTurn(
      deps({ triageError: new LlmError('x', 'timeout'), onAudit: (e) => events.push(e) }),
      input(),
    );
    expect(events).toContain('LLM_FAILOVER');
  });

  it('audits a retrieval failure', async () => {
    const events: string[] = [];
    await runAssessmentTurn(
      deps({ retrievalError: new Error('down'), onAudit: (e) => events.push(e) }),
      input(),
    );
    expect(events).toContain('RETRIEVAL_FAILED');
  });
});

describe('runAssessmentTurn — the state machine drives the questions', () => {
  it('passes the outstanding domain to retrieval', async () => {
    let seen: string | undefined;
    const d = deps({});
    (d.retriever as unknown as { retrieve: (c: { activeDomain?: string }) => Promise<RetrievalOutcome> }).retrieve =
      async (ctx) => {
        seen = ctx.activeDomain;
        return retrieval;
      };

    await runAssessmentTurn(d, input({ knownSlots: { feeding: 'normal' } }));
    // feeding is answered, so breathing is next in clinical order.
    expect(seen).toBe('Breathing');
  });

  it('passes no domain once the assessment is complete', async () => {
    let seen: string | undefined = 'unset';
    const d = deps({});
    (d.retriever as unknown as { retrieve: (c: { activeDomain?: string }) => Promise<RetrievalOutcome> }).retrieve =
      async (ctx) => {
        seen = ctx.activeDomain;
        return retrieval;
      };

    await runAssessmentTurn(
      d,
      input({
        knownSlots: {
          feeding: 'normal', breathing: 'normal', activity: 'alert',
          temperature: 'normal', jaundice: 'none',
        },
      }),
    );
    expect(seen).toBeUndefined();
  });
});
