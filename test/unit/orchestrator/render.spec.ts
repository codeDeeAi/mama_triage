import {
  buildEmergencyMessage,
  isTerminal,
  nextState,
  renderDecision,
} from '../../../src/orchestrator/render';
import type { TriageDecision } from '../../../src/llm/triage';
import type { Language, Urgency } from '../../../src/types';

function decision(overrides: {
  urgency?: Urgency;
  language?: Language;
  action?: Record<string, unknown>;
}): TriageDecision {
  return {
    urgency: overrides.urgency ?? 'self_care',
    urgencyLlm: overrides.urgency ?? 'self_care',
    urgencyRules: null,
    escalatedBy: null,
    redFlags: [],
    slots: {},
    citations: [{ chunk_id: 'who-imci#1', claim: 'c' }],
    model: 'claude-sonnet-5',
    promptVersion: 'triage.v1',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    ungrounded: false,
    result: {
      detected_language: overrides.language ?? 'en',
      pathway: 'neonatal',
      extracted_slots: {},
      red_flags: [],
      urgency: overrides.urgency ?? 'self_care',
      confidence: 'high',
      citations: [{ chunk_id: 'who-imci#1', claim: 'c' }],
      rationale: 'reasoning for the record',
      next_action: (overrides.action ?? {
        type: 'conclude',
        meaning: 'Your baby seems to be doing well.',
        steps: ['Keep feeding on demand', 'Keep the baby warm'],
        return_warnings: ['If the baby stops feeding, seek help'],
      }) as never,
    } as never,
  };
}

describe('renderDecision — asking a question', () => {
  it('sends the question alone when the domain has no demonstration', () => {
    const out = renderDecision(
      decision({ action: { type: 'ask', domain: 'jaundice', question: 'Is the baby yellow?' } }),
    );
    expect(out).toEqual(['Is the baby yellow?']);
  });

  it('sends one message, with no banner and no disclaimer', () => {
    // A question is not a conclusion: none of the conclusion furniture belongs on it.
    const out = renderDecision(
      decision({
        action: { type: 'ask', domain: 'breathing', question: 'How is the baby breathing?' },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('How is the baby breathing?');
    expect(out[0]).not.toMatch(/CARE AT HOME|SEE A HEALTH WORKER|EMERGENCY/);
    expect(out[0]).not.toMatch(/not a diagnosis/i);
  });

  it('offers the demonstration after the question, for a domain that has one', () => {
    // Chest indrawing cannot be described to someone who has never been shown one, and
    // her answer is what the slot — and so the triage decision — rests on.
    const out = renderDecision(
      decision({
        action: { type: 'ask', domain: 'breathing', question: 'How is the baby breathing?' },
      }),
    )[0]!;

    expect(out.indexOf('How is the baby breathing?')).toBeLessThan(
      out.indexOf('globalhealthmedia.org'),
    );
    expect(out).toMatch(/data/i);
  });

  it('never offers a demonstration on an emergency', () => {
    // The only acceptable message there is "go now". Anything competing with it is harm.
    const out = renderDecision(
      decision({
        urgency: 'emergency',
        action: { type: 'ask', domain: 'breathing', question: 'How is the baby breathing?' },
      }),
    )[0]!;

    expect(out).toContain('EMERGENCY');
    expect(out).not.toContain('globalhealthmedia.org');
  });
});

describe('renderDecision — conclusion structure', () => {
  const out = renderDecision(decision({ urgency: 'self_care' }))[0]!;

  it('leads with the urgency banner', () => {
    expect(out.split('\n')[0]).toContain('CARE AT HOME');
    expect(out.split('\n')[0]).toContain('🟢');
  });

  it('includes all five parts', () => {
    expect(out).toContain('Your baby seems to be doing well');
    expect(out).toContain('What to do now');
    expect(out).toContain('1. Keep feeding on demand');
    expect(out).toContain('2. Keep the baby warm');
    expect(out).toContain('Watch for these');
    expect(out).toContain('• If the baby stops feeding');
    expect(out).toMatch(/not a diagnosis/i);
  });

  it('numbers the steps', () => {
    expect(out).toMatch(/1\. .*\n2\. /s);
  });
});

describe('renderDecision — urgency banners', () => {
  it.each([
    ['emergency', 'EMERGENCY', '🔴'],
    ['facility_visit', 'SEE A HEALTH WORKER TODAY', '🟠'],
    ['self_care', 'CARE AT HOME', '🟢'],
  ] as const)('renders the %s banner', (urgency, text, emoji) => {
    const out = renderDecision(decision({ urgency }))[0]!;
    expect(out).toContain(text);
    expect(out).toContain(emoji);
  });
});

describe('renderDecision — emergency placement', () => {
  const out = renderDecision(decision({ urgency: 'emergency' }))[0]!;

  it('puts the referral immediately after the banner', () => {
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines[1]).toMatch(/nearest health facility now/i);
  });

  it('repeats the referral at the end', () => {
    expect(out).toMatch(/nearest health facility now[\s\S]*nearest health facility now/i);
  });

  it('renders nothing above the referral except the banner', () => {
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines[0]).toContain('EMERGENCY');
    expect(lines.slice(0, 2).join(' ')).not.toContain('Your baby seems');
  });
});

describe('renderDecision — an emergency is never delayed by a question', () => {
  it('overrides an "ask" action when urgency is emergency', () => {
    // Covers the model assigning emergency while wanting to keep asking, and the
    // second-pass check escalating a mid-assessment turn. Continuing to ask questions
    // would delay the only instruction that matters.
    const out = renderDecision(
      decision({
        urgency: 'emergency',
        action: { type: 'ask', domain: 'jaundice', question: 'Is the baby yellow?' },
      }),
    )[0]!;

    expect(out).toContain('EMERGENCY');
    expect(out).toMatch(/nearest health facility now/i);
    expect(out).not.toContain('Is the baby yellow?');
  });

  it('still asks the question when urgency is not an emergency', () => {
    const out = renderDecision(
      decision({
        urgency: 'facility_visit',
        action: { type: 'ask', domain: 'jaundice', question: 'Is the baby yellow?' },
      }),
    );
    expect(out).toEqual(['Is the baby yellow?']);
  });
});

describe('renderDecision — Pidgin', () => {
  it('renders the whole conclusion in Pidgin', () => {
    const out = renderDecision(decision({ urgency: 'emergency', language: 'pcm' }))[0]!;
    expect(out).toContain('GO NOW NOW');
    expect(out).toMatch(/health centre wey dey near you/i);
    expect(out).toMatch(/no be doctor talk/i);
  });

  it('uses Pidgin section headings', () => {
    const out = renderDecision(decision({ urgency: 'self_care', language: 'pcm' }))[0]!;
    expect(out).toContain('Wetin to do now');
    expect(out).toContain('CARE FOR HOUSE');
  });
});

describe('buildEmergencyMessage', () => {
  it('brackets the message with the referral directive', () => {
    const out = buildEmergencyMessage('en', false);
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines[0]).toContain('EMERGENCY');
    expect(lines[1]).toMatch(/nearest health facility now/i);
    expect(lines[lines.length - 2]).toMatch(/nearest health facility now/i);
  });

  it('adds mental-health wording when requested', () => {
    expect(buildEmergencyMessage('en', true)).toMatch(/you are not alone/i);
    expect(buildEmergencyMessage('en', false)).not.toMatch(/you are not alone/i);
  });

  it('renders in Pidgin', () => {
    const out = buildEmergencyMessage('pcm', true);
    expect(out).toMatch(/health centre wey dey near you now now/i);
    expect(out).toMatch(/you no dey alone/i);
  });

  it('always carries the disclaimer', () => {
    for (const lang of ['en', 'pcm'] as const) {
      expect(buildEmergencyMessage(lang, false)).toContain(
        lang === 'en' ? 'not a diagnosis' : 'no be doctor talk',
      );
    }
  });
});

describe('state transitions', () => {
  it('an emergency escalates and ends the assessment', () => {
    const d = decision({ urgency: 'emergency' });
    expect(nextState(d)).toBe('escalated');
    expect(isTerminal(d)).toBe(true);
  });

  it('an emergency ends the assessment even mid-question', () => {
    const d = decision({
      urgency: 'emergency',
      action: { type: 'ask', domain: 'x', question: 'q' },
    });
    expect(nextState(d)).toBe('escalated');
  });

  it('a conclusion completes the session', () => {
    expect(nextState(decision({ urgency: 'facility_visit' }))).toBe('completed');
  });

  it('a question keeps the session assessing', () => {
    const d = decision({
      urgency: 'self_care',
      action: { type: 'ask', domain: 'x', question: 'q' },
    });
    expect(nextState(d)).toBe('assessing');
    expect(isTerminal(d)).toBe(false);
  });
});
