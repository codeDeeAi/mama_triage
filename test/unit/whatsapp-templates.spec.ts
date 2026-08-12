/**
 * WhatsApp template submission validity.
 *
 * These templates are pasted by hand into Meta's template manager, and a rejection costs
 * days of review turnaround. Checking the constraints here means an edit that would be
 * rejected fails locally in seconds instead.
 *
 * Constraints encoded: body ≤ 1024 characters, footer ≤ 60, quick-reply button text ≤ 25,
 * template name lowercase with underscores, variables numbered from 1 without gaps, and no
 * variable at the very start or end of a body (Meta rejects both).
 */

import { readFileSync } from 'node:fs';

const RAW = readFileSync('docs/whatsapp-templates-submission.md', 'utf8');

const LIMITS = { body: 1024, footer: 60, button: 25, name: 512 } as const;

interface Template {
  name: string;
  body: string;
  footer: string;
  button: string;
}

function parseTemplates(): Template[] {
  const names = [...RAW.matchAll(/\*\*Name\*\* \| `([^`]+)`/g)].map((m) => m[1]!);
  const footers = [...RAW.matchAll(/\*\*Footer\*\* \| `([^`]+)`/g)].map((m) => m[1]!);
  const buttons = [...RAW.matchAll(/button text: `([^`]+)`/g)].map((m) => m[1]!);
  const bodies = [...RAW.matchAll(/\*\*Body\*\*\n\n```\n([\s\S]*?)```/g)].map((m) =>
    m[1]!.trim(),
  );

  return names.map((name, i) => ({
    name,
    body: bodies[i] ?? '',
    footer: footers[i] ?? '',
    button: buttons[i] ?? '',
  }));
}

const TEMPLATES = parseTemplates();

describe('template submission sheet', () => {
  it('defines all four templates', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      'mama_triage_welcome_en',
      'mama_triage_welcome_pcm',
      'mama_triage_followup_en',
      'mama_triage_followup_pcm',
    ]);
  });

  it('parses a body, footer and button for each', () => {
    for (const t of TEMPLATES) {
      expect(t.body.length).toBeGreaterThan(50);
      expect(t.footer.length).toBeGreaterThan(5);
      expect(t.button.length).toBeGreaterThan(0);
    }
  });
});

describe('Meta length limits', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s is within every limit', (_n, t) => {
    expect(t.body.length).toBeLessThanOrEqual(LIMITS.body);
    expect(t.footer.length).toBeLessThanOrEqual(LIMITS.footer);
    expect(t.button.length).toBeLessThanOrEqual(LIMITS.button);
    expect(t.name.length).toBeLessThanOrEqual(LIMITS.name);
  });
});

describe('Meta formatting rules', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))(
    '%s uses a valid template name',
    (_n, t) => {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
    },
  );

  it.each(TEMPLATES.map((t) => [t.name, t] as const))(
    '%s places no variable at the start or end of the body',
    (_n, t) => {
      expect(t.body.startsWith('{{')).toBe(false);
      expect(t.body.endsWith('}}')).toBe(false);
    },
  );

  it.each(TEMPLATES.map((t) => [t.name, t] as const))(
    '%s has no consecutive variables',
    (_n, t) => {
      expect(t.body).not.toMatch(/\}\}\s*\{\{/);
    },
  );

  it.each(TEMPLATES.map((t) => [t.name, t] as const))(
    '%s numbers variables from 1 with no gaps',
    (_n, t) => {
      const nums = [...new Set([...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))]
        .sort((a, b) => a - b);
      expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
    },
  );

  it('provides sample values for every variable', () => {
    // Missing samples is a commoner cause of rejection than content.
    const sampleBlocks = RAW.match(/\*\*Sample values\*\*/g) ?? [];
    expect(sampleBlocks.length).toBe(TEMPLATES.length);
  });
});

describe('safety copy that must survive any edit', () => {
  const welcome = TEMPLATES.filter((t) => t.name.includes('welcome'));
  const followup = TEMPLATES.filter((t) => t.name.includes('followup'));

  it('every welcome template states it is not a doctor', () => {
    expect(welcome).toHaveLength(2);
    for (const t of welcome) {
      expect(t.body).toMatch(/not a doctor|no be doctor/i);
      expect(t.body).toMatch(/research prototype/i);
    }
  });

  it('every template carries an emergency instruction', () => {
    // If her baby is in danger while she reads this, waiting for a conversation is the
    // wrong advice. This line is the one that must never be edited away.
    for (const t of TEMPLATES) {
      expect(t.body).toMatch(/health facility|health centre/i);
    }
  });

  it('the welcome templates put the emergency line after the invitation, not instead of it', () => {
    for (const t of welcome) {
      const invite = t.body.search(/tap Start/i);
      const emergency = t.body.search(/emergency/i);
      expect(invite).toBeGreaterThan(-1);
      expect(emergency).toBeGreaterThan(invite);
    }
  });

  it('no template promises open-ended health advice', () => {
    // The draft this replaced said "ask any health-related question anytime", which
    // invites exactly the requests ADV-013/014/015 exist to refuse.
    for (const t of TEMPLATES) {
      expect(t.body).not.toMatch(/any health|chat freely|anything you want|any question/i);
    }
  });

  it('the welcome templates name the clinical scope', () => {
    for (const t of welcome) {
      expect(t.body).toMatch(/first year after birth/i);
    }
  });

  it('every footer restates prototype status, so it survives forwarding', () => {
    for (const t of TEMPLATES) {
      expect(t.footer).toMatch(/research prototype/i);
      expect(t.footer).toMatch(/not a medical service|no be medical service/i);
    }
  });

  it('the follow-up templates ask rather than diagnose', () => {
    for (const t of followup) {
      expect(t.body).toMatch(/how is your baby|how your pikin dey/i);
    }
  });
});

describe('language coverage', () => {
  it('provides a Pidgin counterpart for every English template', () => {
    // Meta registers one template per language. Pidgin support in the system is worthless
    // if first contact is English-only.
    const en = TEMPLATES.filter((t) => t.name.endsWith('_en')).map((t) =>
      t.name.replace(/_en$/, ''),
    );
    const pcm = TEMPLATES.filter((t) => t.name.endsWith('_pcm')).map((t) =>
      t.name.replace(/_pcm$/, ''),
    );
    expect(pcm.sort()).toEqual(en.sort());
  });

  it('the Pidgin templates are genuinely different text, not copies', () => {
    const en = TEMPLATES.find((t) => t.name === 'mama_triage_welcome_en')!;
    const pcm = TEMPLATES.find((t) => t.name === 'mama_triage_welcome_pcm')!;
    expect(pcm.body).not.toBe(en.body);
    expect(pcm.body).toMatch(/pikin|dey|abeg|don/i);
  });
});

describe('submission guidance', () => {
  it('requires the Utility category', () => {
    const categories = [...RAW.matchAll(/\*\*Category\*\* \| (\w+)/g)].map((m) => m[1]);
    expect(categories).toHaveLength(TEMPLATES.length);
    for (const c of categories) expect(c).toBe('Utility');
  });

  it('records the Pidgin locale workaround', () => {
    expect(RAW).toMatch(/no Pidgin locale/i);
    expect(RAW).toMatch(/English \(NG\)/);
  });
});
