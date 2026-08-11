/**
 * Inbound message handler — walking skeleton.
 *
 * Implements the parts of the conversation that must exist before any clinical
 * assessment: consent, session lifecycle, and the deterministic safety scan.
 *
 * The safety scan is wired in from the first version deliberately. It runs on every
 * inbound message regardless of session state — including before consent and before a
 * pathway is chosen — because a mother whose baby has stopped breathing must not be asked
 * to accept a data-protection notice first.
 *
 * The assessment state machine (slot filling, RAG, LLM triage) is not yet implemented;
 * `assessing` currently acknowledges and defers. See IMPLEMENTATION_PLAN.md section 8.
 */

import { detectDistress } from '../safety/distress';
import { evaluateRedFlags } from '../safety/redFlags';
import { disclaimer, referralDirective } from '../safety/fallback';
import { hashPhone } from '../privacy/hashPhone';
import type { InboundMessage } from '../whatsapp/types';
import type { WhatsAppClient } from '../whatsapp/client';
import type { SessionRepository, SessionRow } from '../db/repositories/session.repo';
import type { MessageRepository } from '../db/repositories/message.repo';
import type { AuditRepository } from '../db/repositories/event.repo';
import type { Logger } from '../telemetry/logger';
import type { Language, Pathway } from '../types';

export interface HandlerDeps {
  sessions: SessionRepository;
  messages: MessageRepository;
  audit: AuditRepository;
  whatsapp: WhatsAppClient;
  logger: Logger;
  pepper: string;
  sessionTtlMinutes: number;
}

export const CONSENT_ACCEPT_ID = 'CONSENT_ACCEPT';
export const CONSENT_DECLINE_ID = 'CONSENT_DECLINE';
export const PATHWAY_MOTHER_ID = 'PATHWAY_MOTHER';
export const PATHWAY_BABY_ID = 'PATHWAY_BABY';

const CONSENT_COPY: Record<Language, string> = {
  en:
    '👋 Hello. I am a *research prototype* that helps check danger signs for mothers ' +
    'and newborn babies.\n\n' +
    '*I am not a doctor and I do not give diagnoses.* I can help you decide whether to ' +
    'care at home, visit a clinic, or go for emergency help.\n\n' +
    'To continue, I need your agreement to store an *anonymous* copy of this ' +
    'conversation for research. Your phone number is never saved.\n\n' +
    'Do you agree to continue?',
  pcm:
    '👋 How far. Na *research prototype* I be wey dey help check danger signs for mama ' +
    'and new pikin.\n\n' +
    '*I no be doctor and I no dey give diagnosis.* I fit help you decide if to care for ' +
    'house, go clinic, or run go emergency.\n\n' +
    'Make we continue, I need your agreement make I keep *anonymous* copy of dis ' +
    'conversation for research. We no dey save your phone number.\n\n' +
    'You gree make we continue?',
};

const PATHWAY_PROMPT: Record<Language, string> = {
  en: 'Who do you want to check today?',
  pcm: 'Who you wan check today?',
};

const DECLINED_COPY: Record<Language, string> = {
  en:
    'That is completely fine. I have not saved anything.\n\n' +
    'If you or your baby are unwell, please go to the nearest health facility.\n\n' +
    'Send a message any time if you change your mind.',
  pcm:
    'No wahala at all. I no keep anything.\n\n' +
    'If you or your pikin no well, abeg go health centre wey dey near you.\n\n' +
    'Send message any time if you change your mind.',
};

const UNSUPPORTED_COPY: Record<Language, string> = {
  en: 'I can only read text messages for now. Please describe what you are seeing in words.',
  pcm: 'Na text message only I fit read for now. Abeg use word describe wetin you dey see.',
};

/**
 * Very small language heuristic for the pre-LLM stages.
 *
 * Only used before the LLM is in play (consent, pathway choice). Once assessment starts,
 * the model's `detected_language` field is authoritative — this exists so the consent
 * message itself can be in the right language.
 */
const PIDGIN_MARKERS =
  /\b(?:abeg|wetin|dey|na|pikin|wahala|no be|comot|sabi|make i|how far|una)\b/i;

export function detectLanguageHeuristic(text: string): Language {
  return PIDGIN_MARKERS.test(text) ? 'pcm' : 'en';
}

export function createMessageHandler(deps: HandlerDeps) {
  return async function handleMessage(msg: InboundMessage): Promise<void> {
    const receivedAt = Date.now();
    const waIdHash = hashPhone(msg.from, deps.pepper);

    const { session } = await deps.sessions.findOrCreate(
      waIdHash,
      deps.sessionTtlMinutes,
      detectLanguageHeuristic(msg.text),
    );

    await deps.messages.record({
      sessionId: session.id,
      direction: 'inbound',
      body: msg.text,
      waMessageId: msg.waMessageId,
      detectedLang: session.language,
    });

    const reply = async (body: string): Promise<void> => {
      await deps.whatsapp.sendText(msg.from, body);
      await deps.messages.record({
        sessionId: session.id,
        direction: 'outbound',
        body,
        detectedLang: session.language,
        latencyMs: Date.now() - receivedAt,
      });
    };

    // ---------------------------------------------------------------------------
    // SAFETY FIRST. Runs on every message, in every state, before anything else.
    // ---------------------------------------------------------------------------
    const escalated = await runSafetyScan(deps, session, msg, reply);
    if (escalated) return;

    if (msg.kind === 'unsupported') {
      await reply(UNSUPPORTED_COPY[session.language]);
      return;
    }

    switch (session.state) {
      case 'new':
        await deps.sessions.setState(session.id, 'awaiting_consent');
        await deps.whatsapp.sendButtons(msg.from, CONSENT_COPY[session.language], [
          { id: CONSENT_ACCEPT_ID, title: 'Yes, continue' },
          { id: CONSENT_DECLINE_ID, title: 'No, thank you' },
        ]);
        await deps.messages.record({
          sessionId: session.id,
          direction: 'outbound',
          body: CONSENT_COPY[session.language],
          detectedLang: session.language,
          latencyMs: Date.now() - receivedAt,
        });
        return;

      case 'awaiting_consent':
        await handleConsent(deps, session, msg, reply, receivedAt);
        return;

      case 'choosing_pathway':
        await handlePathwayChoice(deps, session, msg, reply);
        return;

      case 'assessing':
        // Assessment state machine lands in sprint 4.
        await reply(
          session.language === 'en'
            ? 'Thank you. The full symptom assessment is still being built. ' +
              'If you are worried about anything, please go to the nearest health facility.'
            : 'Thank you. Di full assessment never ready. ' +
              'If anything dey worry you, abeg go health centre wey dey near you.',
        );
        return;

      /* istanbul ignore next -- terminal states are not reachable via findActive */
      default:
        await deps.sessions.touch(session.id);
        return;
    }
  };
}

/**
 * Deterministic safety scan.
 *
 * @returns true when the session was escalated and the caller must stop.
 */
async function runSafetyScan(
  deps: HandlerDeps,
  session: SessionRow,
  msg: InboundMessage,
  reply: (body: string) => Promise<void>,
): Promise<boolean> {
  if (!msg.text) return false;

  const distress = detectDistress(msg.text);
  const flags = evaluateRedFlags({
    text: msg.text,
    slots: session.slots,
    pathway: session.pathway as Pathway,
  });

  if (flags.hits.length > 0) {
    await deps.audit.record(
      'RED_FLAG_HIT',
      { ids: flags.hits.map((h) => h.id), urgency: flags.urgency },
      session.id,
    );
  }

  if (distress.detected) {
    await deps.audit.record(
      'DISTRESS_DETECTED',
      { categories: distress.categories },
      session.id,
    );
  }

  const isEmergency = flags.urgency === 'emergency' || distress.detected;
  if (!isEmergency) {
    // Non-emergency flags still raise the session high-water mark.
    if (flags.urgency) await deps.sessions.raiseUrgency(session.id, flags.urgency);
    return false;
  }

  await deps.sessions.raiseUrgency(session.id, 'emergency');
  await deps.sessions.setState(session.id, 'escalated');
  await deps.audit.record(
    'EMERGENCY_ISSUED',
    { via: distress.detected ? 'distress' : 'red_flag', ids: flags.hits.map((h) => h.id) },
    session.id,
  );

  await reply(buildEmergencyMessage(session.language, distress.needsMentalHealthReferral));
  deps.logger.warn({ sessionId: session.id }, 'session escalated to emergency');
  return true;
}

/** The referral directive leads and closes the message; nothing is rendered above it. */
export function buildEmergencyMessage(
  language: Language,
  mentalHealth: boolean,
): string {
  const lines: string[] = [];

  lines.push(language === 'en' ? '🔴 *EMERGENCY*' : '🔴 *EMERGENCY*');
  lines.push('');
  lines.push(referralDirective(language));
  lines.push('');
  lines.push(
    language === 'en'
      ? 'What you have described can be serious and needs to be checked by a health worker straight away. Do not wait to see if it improves.'
      : 'Wetin you talk fit serious, health worker need to check am sharp sharp. No wait make e better first.',
  );

  if (mentalHealth) {
    lines.push('');
    lines.push(
      language === 'en'
        ? 'You are not alone, and what you are feeling can be helped. Please tell a health worker, or someone you trust, how you are feeling today.'
        : 'You no dey alone, and wetin you dey feel get help. Abeg tell health worker, or person wey you trust, how you dey feel today.',
    );
  }

  lines.push('');
  lines.push(referralDirective(language));
  lines.push('');
  lines.push(disclaimer(language));

  return lines.join('\n');
}

async function handleConsent(
  deps: HandlerDeps,
  session: SessionRow,
  msg: InboundMessage,
  reply: (body: string) => Promise<void>,
  receivedAt: number,
): Promise<void> {
  const said = msg.text.trim().toLowerCase();
  const accepted =
    msg.replyId === CONSENT_ACCEPT_ID ||
    /^(yes|y|ok|okay|agree|i agree|continue|yes continue|gree|i gree)$/i.test(said);
  const declined =
    msg.replyId === CONSENT_DECLINE_ID || /^(no|n|no thanks|no thank you|stop)$/i.test(said);

  if (accepted) {
    await deps.sessions.recordConsent(session.id);
    await deps.audit.record('CONSENT_GIVEN', {}, session.id);
    await deps.whatsapp.sendButtons(msg.from, PATHWAY_PROMPT[session.language], [
      { id: PATHWAY_MOTHER_ID, title: 'For me (mother)' },
      { id: PATHWAY_BABY_ID, title: 'For my baby' },
    ]);
    await deps.messages.record({
      sessionId: session.id,
      direction: 'outbound',
      body: PATHWAY_PROMPT[session.language],
      detectedLang: session.language,
      latencyMs: Date.now() - receivedAt,
    });
    return;
  }

  if (declined) {
    await deps.sessions.setState(session.id, 'abandoned');
    await deps.audit.record('CONSENT_DECLINED', {}, session.id);
    await reply(DECLINED_COPY[session.language]);
    return;
  }

  await reply(
    session.language === 'en'
      ? 'Please tap *Yes, continue* or *No, thank you* to go on.'
      : 'Abeg tap *Yes, continue* or *No, thank you* make we continue.',
  );
}

async function handlePathwayChoice(
  deps: HandlerDeps,
  session: SessionRow,
  msg: InboundMessage,
  reply: (body: string) => Promise<void>,
): Promise<void> {
  const said = msg.text.trim().toLowerCase();
  const maternal =
    msg.replyId === PATHWAY_MOTHER_ID || /\b(me|mother|mama|myself|my ?self)\b/i.test(said);
  const neonatal =
    msg.replyId === PATHWAY_BABY_ID || /\b(baby|pikin|child|newborn|my baby)\b/i.test(said);

  // Check neonatal first: "for my baby" contains neither ambiguity nor "me" as a word,
  // but a mother writing "my baby and me" should be routed to the baby.
  const chosen: Pathway | null = neonatal ? 'neonatal' : maternal ? 'maternal' : null;

  if (!chosen) {
    await reply(
      session.language === 'en'
        ? 'Please tap *For me (mother)* or *For my baby*.'
        : 'Abeg tap *For me (mother)* or *For my baby*.',
    );
    return;
  }

  await deps.sessions.setPathway(session.id, chosen);
  await deps.sessions.setState(session.id, 'assessing');

  await reply(
    chosen === 'neonatal'
      ? session.language === 'en'
        ? 'Thank you. I will ask a few questions about your baby.'
        : 'Thank you. I go ask small questions about your pikin.'
      : session.language === 'en'
        ? 'Thank you. I will ask a few questions about how you are feeling.'
        : 'Thank you. I go ask small questions about how you dey feel.',
  );
}
