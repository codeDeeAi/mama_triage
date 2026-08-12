import {
  buildParams,
  findTemplate,
  missingFor,
  registeredFor,
  TEMPLATES,
  TemplateNotRegisteredError,
  templateIdFor,
} from '../../src/whatsapp/templates';
import { KudiSmsTransport } from '../../src/whatsapp/kudisms';

describe('template registry', () => {
  it('defines welcome and follow-up in both languages', () => {
    expect(TEMPLATES).toHaveLength(4);
    for (const key of ['welcome', 'followup'] as const) {
      for (const lang of ['en', 'pcm'] as const) {
        expect(findTemplate(key, lang)).toBeDefined();
      }
    }
  });

  it('matches the names on the submission sheet', () => {
    expect(TEMPLATES.map((t) => t.metaName).sort()).toEqual([
      'mama_triage_followup_en',
      'mama_triage_followup_pcm',
      'mama_triage_welcome_en',
      'mama_triage_welcome_pcm',
    ]);
  });

  it('carries the KudiSMS codes registered on the WABA', () => {
    expect(templateIdFor('kudisms', 'welcome', 'en')).toBe('9153948463');
    expect(templateIdFor('kudisms', 'welcome', 'pcm')).toBe('4269075219');
    expect(templateIdFor('kudisms', 'followup', 'en')).toBe('5929612479');
  });

  it('uses the template name for Meta', () => {
    expect(templateIdFor('meta-cloud-api', 'welcome', 'en')).toBe('mama_triage_welcome_en');
  });

  it('names each parameter, so a transposition is visible', () => {
    expect(findTemplate('welcome', 'en').paramNames).toEqual(['motherName', 'studyName']);
    expect(findTemplate('followup', 'en').paramNames).toEqual(['motherName', 'elapsed']);
  });
});

describe('unregistered templates fail loudly', () => {
  it('throws for the Pidgin follow-up, which is not yet on the WABA', () => {
    // Silently falling back to English would send a mother who has been conversing in
    // Pidgin a follow-up she may not read.
    expect(() => templateIdFor('kudisms', 'followup', 'pcm')).toThrow(
      TemplateNotRegisteredError,
    );
    expect(() => templateIdFor('kudisms', 'followup', 'pcm')).toThrow(/no KudiSMS template_code/);
  });

  it('reports what is registered and what is missing', () => {
    expect(registeredFor('kudisms')).toHaveLength(3);
    expect(missingFor('kudisms').map((t) => t.metaName)).toEqual(['mama_triage_followup_pcm']);
    expect(missingFor('meta-cloud-api')).toEqual([]);
  });

  it('throws for an unknown key or language', () => {
    expect(() => findTemplate('welcome', 'fr' as never)).toThrow(TemplateNotRegisteredError);
  });
});

describe('parameter validation', () => {
  it('accepts the right number of parameters', () => {
    expect(buildParams('welcome', 'en', ['Amina', 'the MIVA study'])).toHaveLength(2);
  });

  it('rejects the wrong number, naming what was expected', () => {
    expect(() => buildParams('welcome', 'en', ['Amina'])).toThrow(/expects 2 parameter/);
    expect(() => buildParams('welcome', 'en', ['Amina'])).toThrow(/motherName, studyName/);
  });
});

describe('KudiSmsTransport.sendTemplate', () => {
  function harness() {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(Object.fromEntries(new URLSearchParams(init.body as string)));
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof fetch;

    return {
      calls,
      transport: new KudiSmsTransport({ token: 'tok', phoneNumberId: 'PNID', fetchImpl }),
    };
  }

  it('posts the template code and parameters', async () => {
    const h = harness();
    await h.transport.sendTemplate('2348012345678', {
      template: '9153948463',
      params: ['Amina', 'the MIVA maternal health study'],
    });

    expect(h.calls[0]).toMatchObject({
      token: 'tok',
      recipient: '2348012345678',
      phone_number_id: 'PNID',
      template_code: '9153948463',
      parameters: 'Amina,the MIVA maternal health study',
    });
  });

  it('strips commas from parameter values', async () => {
    // KudiSMS takes parameters as one comma-separated string, so a comma inside a value
    // would shift every later parameter into the wrong placeholder.
    const h = harness();
    await h.transport.sendTemplate('234801', {
      template: '9153948463',
      params: ['Amina, mother of two', 'the study'],
    });
    expect(h.calls[0]?.parameters).toBe('Amina mother of two,the study');
  });

  it('can send a template even though free text is unavailable', async () => {
    // The distinction that matters: KudiSMS can open a conversation but cannot hold one.
    const h = harness();
    expect(h.transport.capabilities.freeTextOutbound).toBe(false);
    await expect(
      h.transport.sendTemplate('234801', { template: '9153948463', params: ['A', 'B'] }),
    ).resolves.toBeUndefined();
  });

  it('still refuses free text without a configured template code', async () => {
    const h = harness();
    await expect(h.transport.sendText('234801', 'a triage reply')).rejects.toThrow(
      /cannot be sent this way/,
    );
  });
});
