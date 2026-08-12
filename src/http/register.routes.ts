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

export function createRegisterRouter(deps: RegisterDeps): Router {
  const router = Router();

  /** What the form should offer. */
  router.get('/register/api/channels', (_req: Request, res: Response) => {
    res.json({
      channels: deps.availableChannels,
      telegramBotUsername: deps.telegramBotUsername ?? null,
      studyName: deps.studyName ?? 'the MIVA maternal health study',
    });
  });

  router.post('/register/api', async (req: Request, res: Response) => {
    const parsed = RegisterRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid registration',
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const { displayName, channel, language, phone } = parsed.data;

    if (!deps.availableChannels.includes(channel)) {
      res.status(400).json({
        error: `${channel} is not available on this deployment`,
      });
      return;
    }

    // ---- Telegram: no identifier collected -----------------------------------------
    if (channel === 'telegram') {
      if (!deps.telegramBotUsername) {
        res.status(503).json({ error: 'Telegram is not configured' });
        return;
      }

      const reg = await deps.registrations.createTelegram(displayName);
      deps.logger.info({ registrationId: reg.id, channel }, 'registration created');

      res.json({
        channel,
        registrationId: reg.id,
        // The token travels only in the link she opens; nothing about her is stored yet.
        deepLink: `https://t.me/${deps.telegramBotUsername}?start=${reg.link_token}`,
        instructions:
          'Open the link on the phone that has Telegram installed, then press START.',
      });
      return;
    }

    // ---- WhatsApp: phone hashed before storage --------------------------------------
    let identityHash: string;
    try {
      identityHash = hashIdentity('whatsapp', phone as string, deps.pepper);
    } catch {
      res.status(400).json({
        error: 'invalid registration',
        issues: [{ field: 'phone', message: 'That does not look like a phone number' }],
      });
      return;
    }

    const reg = await deps.registrations.createWhatsApp(displayName, identityHash);
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

    res.json({
      channel,
      registrationId: reg.id,
      welcomeSent,
      instructions: welcomeSent
        ? 'Check WhatsApp for a message from us, and reply to begin.'
        : 'We could not send the welcome message. Send a WhatsApp message to our number to begin.',
    });
  });

  return router;
}
