/**
 * Registration endpoints.
 *
 * Collects the minimum each channel needs and nothing more:
 *
 *   Telegram  — a display name. No phone number, ever. She receives a deep link, and her
 *               chat is bound when she opens the bot.
 *   WhatsApp  — a display name and a phone number, because that channel cannot address
 *               her without one. The number is hashed before it touches the database.
 *
 * Asking for a phone number "just in case" would be the easy thing to do and would
 * quietly discard the privacy advantage the Telegram path has.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { hashIdentity } from '../privacy/hashPhone';
import { normalisePhone } from '../privacy/hashPhone';
import type { RegistrationRepository } from '../db/repositories/registration.repo';
import type { MessageTransport } from '../whatsapp/transport';
import { templateIdFor } from '../whatsapp/templates';
import { PRIVACY_VERSION, TERMS_VERSION } from '../web/policyVersions';
import type { Logger } from '../telemetry/logger';

export interface RegisterDeps {
  registrations: RegistrationRepository;
  pepper: string;
  logger: Logger;
  /** Channels this deployment actually offers, for the form to render honestly. */
  availableChannels: Array<'whatsapp' | 'telegram'>;
  /** Bot username, for the t.me deep link. */
  telegramBotUsername?: string;
  /** Used to send the welcome template on the WhatsApp path. */
  whatsappTransport?: MessageTransport;
  /** Shown in the welcome message, e.g. "the MIVA maternal health study". */
  studyName?: string;
}

const RegisterRequest = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Please enter the name you would like to be called')
      .max(80),
    channel: z.enum(['whatsapp', 'telegram']),
    language: z.enum(['en', 'pcm']).default('en'),
    /** Required for WhatsApp only. */
    phone: z.string().trim().optional(),
    /**
     * Consent to the terms and privacy notice, and to being contacted.
     *
     * An unchecked checkbox is simply absent from a form post, so a missing value is a
     * refusal rather than a malformed request. Validated here as well as in the form:
     * the record must not be creatable without it.
     */
    consent: z.literal('yes', {
      errorMap: () => ({
        message: 'Please confirm you have read and agree to the terms and privacy notice',
      }),
    }),
  })
  .refine((v) => v.channel !== 'whatsapp' || (v.phone && v.phone.length >= 10), {
    message: 'A phone number is needed for WhatsApp',
    path: ['phone'],
  })
  .refine((v) => v.channel !== 'telegram' || !v.phone, {
    // Guards the privacy property rather than trusting the client not to send it.
    message: 'Telegram registration must not include a phone number',
    path: ['phone'],
  });

/** Shown on the policy pages. Bump alongside the version constants. */
const POLICY_UPDATED = '12 August 2026';

export function createRegisterRouter(deps: RegisterDeps): Router {
  const router = Router();

  /** Landing page. */
  router.get('/', (_req: Request, res: Response) => {
    res.render('landing', { title: 'MamaTriage — know when to worry' });
  });

  router.get('/privacy', (_req: Request, res: Response) => {
    res.render('privacy', {
      title: 'Privacy notice — MamaTriage',
      privacyVersion: PRIVACY_VERSION,
      updated: POLICY_UPDATED,
    });
  });

  router.get('/terms', (_req: Request, res: Response) => {
    res.render('terms', {
      title: 'Terms of use — MamaTriage',
      termsVersion: TERMS_VERSION,
      updated: POLICY_UPDATED,
    });
  });

  /** Registration form. */
  router.get('/register', (_req: Request, res: Response) => {
    res.render('register', {
      title: 'Join MamaTriage',
      channels: deps.availableChannels,
    });
  });

  /**
   * Form submission.
   *
   * htmx posts here and swaps in a server-rendered fragment, so success and error states
   * use the same templates the server already owns rather than being rebuilt in the
   * browser. A normal (non-htmx) POST still works and renders a full page.
   */
  router.post('/register', async (req: Request, res: Response) => {
    const isHtmx = req.get('HX-Request') === 'true';
    const outcome = await register(deps, req.body as Record<string, unknown>);

    if (!outcome.ok) {
      const view = { title: 'Join MamaTriage', channels: deps.availableChannels,
                     errors: outcome.issues, values: req.body as Record<string, unknown> };
      // 422 rather than 400: htmx only swaps error responses when told to, and the
      // registration form opts in via hx-swap on this status.
      res.status(422);
      // htmx swaps in just the form region; a normal POST re-renders the whole page.
      // Both come from the same partial, so the two paths cannot drift.
      if (isHtmx) {
        res.render('partials/form', view);
        return;
      }
      res.render('register', view);
      return;
    }

    const view = {
      title: 'Registered — MamaTriage',
      ...outcome.result,
      botUsername: deps.telegramBotUsername ?? '',
    };
    if (isHtmx) {
      res.render('partials/result', view);
      return;
    }
    res.render('register-done', view);
  });

  /** What the form should offer. */
  router.get('/register/api/channels', (_req: Request, res: Response) => {
    res.json({
      channels: deps.availableChannels,
      telegramBotUsername: deps.telegramBotUsername ?? null,
      studyName: deps.studyName ?? 'the MIVA maternal health study',
    });
  });

  /** JSON API, kept for the evaluation harness and for programmatic use. */
  router.post('/register/api', async (req: Request, res: Response) => {
    const outcome = await register(deps, req.body as Record<string, unknown>);
    if (!outcome.ok) {
      res.status(400).json({ error: 'invalid registration', issues: outcome.issues });
      return;
    }
    res.json(outcome.result);
  });

  return router;
}

interface RegisterIssue {
  field: string;
  message: string;
}

type RegisterOutcome =
  | { ok: false; issues: RegisterIssue[] }
  | { ok: true; result: Record<string, unknown> };

/** Shared by the HTML form and the JSON API, so the two cannot diverge. */
async function register(
  deps: RegisterDeps,
  body: Record<string, unknown>,
): Promise<RegisterOutcome> {
  {
    const parsed = RegisterRequest.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      };
    }

    const { displayName, channel, language, phone } = parsed.data;
    const policy = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };

    if (!deps.availableChannels.includes(channel)) {
      return {
        ok: false,
        issues: [{ field: 'channel', message: `${channel} is not available here` }],
      };
    }

    // ---- Telegram: no identifier collected -----------------------------------------
    if (channel === 'telegram') {
      if (!deps.telegramBotUsername) {
        return {
          ok: false,
          issues: [{ field: 'channel', message: 'Telegram is not configured here' }],
        };
      }

      const reg = await deps.registrations.createTelegram(displayName, policy);
      deps.logger.info({ registrationId: reg.id, channel }, 'registration created');

      return {
        ok: true,
        result: {
          channel,
          displayName,
          registrationId: reg.id,
          // The token travels only in the link she opens; nothing about her is stored yet.
          deepLink: `https://t.me/${deps.telegramBotUsername}?start=${reg.link_token}`,
          instructions:
            'Open the link on the phone that has Telegram installed, then press START.',
        },
      };
    }

    // ---- WhatsApp: phone hashed before storage --------------------------------------
    let identityHash: string;
    try {
      identityHash = hashIdentity('whatsapp', phone as string, deps.pepper);
    } catch {
      return {
        ok: false,
        issues: [{ field: 'phone', message: 'That does not look like a phone number' }],
      };
    }

    const reg = await deps.registrations.createWhatsApp(displayName, identityHash, policy);
    deps.logger.info({ registrationId: reg.id, channel }, 'registration created');

    // Send the approved welcome template. The mother's reply is what opens the session
    // window, so the template must invite one — see prompts/whatsapp-templates.md.
    let welcomeSent = false;
    if (deps.whatsappTransport) {
      try {
        await deps.whatsappTransport.sendTemplate(normalisePhone(phone as string), {
          template: templateIdFor(
            deps.whatsappTransport.capabilities.provider,
            'welcome',
            language,
          ),
          params: [displayName, deps.studyName ?? 'the MIVA maternal health study'],
          language,
        });
        welcomeSent = true;
      } catch (err) {
        // Registration succeeded even if the welcome did not; she can still message the
        // number directly. Reporting this honestly beats a false "check your WhatsApp".
        deps.logger.error({ err, registrationId: reg.id }, 'welcome template failed');
      }
    }

    return {
      ok: true,
      result: {
        channel,
        displayName,
        registrationId: reg.id,
        welcomeSent,
        instructions: welcomeSent
          ? 'Check WhatsApp for a message from us, and reply to begin.'
          : 'We could not send the welcome message. Send a WhatsApp message to our number to begin.',
      },
    };
  }
}
