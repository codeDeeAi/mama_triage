/**
 * Approved template registry.
 *
 * Providers identify templates differently — Meta by name, KudiSMS by a numeric
 * `template_code` issued at approval — so the identifier is resolved per provider rather
 * than hard-coded at the call site.
 *
 * Codes below are the ones registered on the project's KudiSMS WABA. They are not
 * secrets: a template code is useless without the account token, and keeping them in
 * source means the mapping is reviewable and testable rather than living only in a
 * dashboard screenshot.
 */

import type { Language } from '../types';

export type TemplateKey = 'welcome' | 'followup';

export interface TemplateDefinition {
  key: TemplateKey;
  language: Language;
  /** Meta template name. */
  metaName: string;
  /** KudiSMS template_code, from the WhatsApp Manager template list. */
  kudiSmsCode?: string;
  /**
   * The approved body text, with {{1}}, {{2}} placeholders.
   *
   * Held here so a transport with no template system (Telegram) can render exactly the
   * same words WhatsApp delivers. A mother should read identical copy whichever channel
   * she registered on, or the two arms of the evaluation are not comparable.
   */
  body: string;
  /** Number of body parameters the approved template expects. */
  paramCount: number;
  /** What each parameter means, so a caller cannot silently transpose them. */
  paramNames: readonly string[];
}

export const TEMPLATES: readonly TemplateDefinition[] = Object.freeze([
  {
    key: 'welcome',
    language: 'en',
    metaName: 'mama_triage_welcome_en',
    body:
      'Hi {{1}}, you are now registered with {{2}}.\n\nI help mothers check danger signs for themselves and for their baby during the first year after birth. I am a research prototype, not a doctor, and I do not give diagnoses.\n\nIf something is worrying you now, tap Start below and I will ask you a few short questions.\n\nIf you think this is an emergency, do not wait for me. Go to your nearest health facility straight away.',
    kudiSmsCode: '9153948463',
    paramCount: 2,
    paramNames: ['motherName', 'studyName'],
  },
  {
    key: 'welcome',
    language: 'pcm',
    metaName: 'mama_triage_welcome_pcm',
    body:
      'Hi {{1}}, you don register with {{2}}.\n\nI dey help mama check danger signs for herself and for her pikin for di first year after birth. Na research prototype I be, I no be doctor, and I no dey give diagnosis.\n\nIf anything dey worry you now, tap Start make I ask you small questions.\n\nIf you think say na emergency, no wait for me. Go health centre wey dey near you now now.',
    kudiSmsCode: '4269075219',
    paramCount: 2,
    paramNames: ['motherName', 'studyName'],
  },
  {
    key: 'followup',
    language: 'en',
    metaName: 'mama_triage_followup_en',
    body:
      'Hi {{1}}, we spoke {{2}} ago about your baby, and I advised you to see a health worker.\n\nHow is your baby now? Tap below to tell me and I will ask a few short questions.\n\nIf anything has become worse, please go to your nearest health facility now.',
    kudiSmsCode: '5929612479',
    paramCount: 2,
    paramNames: ['motherName', 'elapsed'],
  },
  {
    key: 'followup',
    language: 'pcm',
    metaName: 'mama_triage_followup_pcm',
    body:
      'Hi {{1}}, we talk {{2}} ago about your pikin, and I tell you make you see health worker.\n\nHow your pikin dey now? Tap below make you tell me and I go ask small questions.\n\nIf anything don worse, abeg go health centre wey dey near you now.',
    // Not yet registered — the Pidgin follow-up is missing from the WABA template list.
    // Resolution throws rather than silently falling back to English, because a mother
    // who has been conversing in Pidgin should not receive an English follow-up.
    paramCount: 2,
    paramNames: ['motherName', 'elapsed'],
  },
]);

export class TemplateNotRegisteredError extends Error {
  override readonly name = 'TemplateNotRegisteredError';
}

export function findTemplate(key: TemplateKey, language: Language): TemplateDefinition {
  const found = TEMPLATES.find((t) => t.key === key && t.language === language);
  if (!found) {
    throw new TemplateNotRegisteredError(`no template defined for ${key}/${language}`);
  }
  return found;
}

/**
 * Resolve the identifier a given provider needs.
 *
 * @throws {TemplateNotRegisteredError} when the template has not been approved for that
 *   provider. Failing loudly matters: sending an unregistered code is rejected by the API
 *   anyway, and falling back to another language would put a mother's follow-up in a
 *   language she may not read.
 */
export function templateIdFor(
  provider: string,
  key: TemplateKey,
  language: Language,
): string {
  const t = findTemplate(key, language);

  if (provider === 'kudisms') {
    if (!t.kudiSmsCode) {
      throw new TemplateNotRegisteredError(
        `template ${t.metaName} has no KudiSMS template_code. Register it in WhatsApp ` +
          `Manager and add the code to src/whatsapp/templates.ts.`,
      );
    }
    return t.kudiSmsCode;
  }

  return t.metaName;
}

/** Validate parameters before sending, so a transposition fails locally. */
export function buildParams(
  key: TemplateKey,
  language: Language,
  params: readonly string[],
): readonly string[] {
  const t = findTemplate(key, language);
  if (params.length !== t.paramCount) {
    throw new Error(
      `template ${t.metaName} expects ${t.paramCount} parameter(s) ` +
        `(${t.paramNames.join(', ')}), received ${params.length}`,
    );
  }
  return params;
}

/**
 * Render a template's body with its parameters substituted.
 *
 * Used by transports that have no template system, so the copy a Telegram user reads is
 * the copy Meta approved rather than a second, drifting version.
 */
export function renderTemplate(
  key: TemplateKey,
  language: Language,
  params: readonly string[],
): string {
  const t = findTemplate(key, language);
  buildParams(key, language, params);
  return t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? '');
}

/** Templates approved on a given provider. Used by the readiness check. */
export function registeredFor(provider: string): TemplateDefinition[] {
  return TEMPLATES.filter((t) => (provider === 'kudisms' ? Boolean(t.kudiSmsCode) : true));
}

/** Templates still missing from a provider, for operational visibility. */
export function missingFor(provider: string): TemplateDefinition[] {
  return TEMPLATES.filter((t) => (provider === 'kudisms' ? !t.kudiSmsCode : false));
}
