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
import { hashIdentity } from '../privacy/hashPhone';
import type { InboundMessage } from '../whatsapp/types';
import type { MessageTransport } from '../whatsapp/transport';
import type { SessionRepository, SessionRow } from '../db/repositories/session.repo';
import type { MessageRepository } from '../db/repositories/message.repo';
import type { AuditRepository } from '../db/repositories/event.repo';
import type { OutcomeRepository } from '../db/repositories/outcome.repo';
import type { RegistrationRepository } from '../db/repositories/registration.repo';
import type { FollowUpRepository } from '../db/repositories/followup.repo';
import { dueAt, planFollowUp } from './followUp';
import { nextDomain } from './pathways';
import type { Logger } from '../telemetry/logger';
import type { Language, Pathway } from '../types';
import { buildEmergencyMessage } from './render';
import { runAssessmentTurn, type AssessmentDeps } from './assessment';

export interface HandlerDeps {
  sessions: SessionRepository;
  messages: MessageRepository;
  audit: AuditRepository;
  whatsapp: MessageTransport;
  logger: Logger;
  pepper: string;
  sessionTtlMinutes: number;
  /**
   * Assessment services. Optional so the consent and safety paths can be exercised
   * without an LLM configured; when absent, `assessing` replies that the assessment is
   * unavailable rather than failing.
   */
  assessment?: AssessmentDeps;
  outcomes?: OutcomeRepository;
  /** Optional: links a Telegram deep-link registration to its chat on first contact. */
  registrations?: RegistrationRepository;
  /** Optional: queues the IMCI follow-up reminders. */
  followUps?: FollowUpRepository;
  /** How many prior messages to include as conversation context. */
  transcriptWindow?: number;
}

export { buildEmergencyMessage };

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
    const waIdHash = hashIdentity(msg.channel, msg.from, deps.pepper);

    // A Telegram registration holds no identifier until this moment: the deep-link token
    // is what binds her chat to the name she gave on the web form. Single-use, so a
    // forwarded link cannot attach someone else's chat to her registration.
    const startPayload = (msg as { startPayload?: string }).startPayload;
    if (startPayload && deps.registrations) {
      const linked = await deps.registrations.linkTelegram(startPayload, waIdHash);
      deps.logger.info(
        { linked: Boolean(linked) },
        linked ? 'registration linked to chat' : 'registration token unknown or already used',
      );
    }

    const { session } = await deps.sessions.findOrCreate(
      waIdHash,
      deps.sessionTtlMinutes,
      detectLanguageHeuristic(msg.text),
    );

    // Re-detect on every pre-assessment turn. A mother may open with "hello" and switch
    // to Pidgin once she starts describing symptoms; detecting only at session creation
    // left her reading an emergency referral in the wrong language. Once assessment
    // begins the model's `detected_language` is authoritative and overrides this.
    if (msg.text && session.state !== 'assessing') {
      const detected = detectLanguageHeuristic(msg.text);
      if (detected !== session.language && detected === 'pcm') {
        await deps.sessions.setLanguage(session.id, detected);
        session.language = detected;
      }
    }

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
        await deps.whatsapp.sendOptions(msg.from, CONSENT_COPY[session.language], [
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
        await handleAssessment(deps, session, msg, reply, receivedAt);
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

/**
 * Run one assessment turn and apply its result to the session.
 *
 * The session is updated before the reply is sent: if delivery fails, the slots and
 * urgency the mother's answer established are already recorded, so a retry does not lose
 * clinical information.
 */
async function handleAssessment(
  deps: HandlerDeps,
  session: SessionRow,
  msg: InboundMessage,
  reply: (body: string) => Promise<void>,
  receivedAt: number,
): Promise<void> {
  if (!deps.assessment) {
    await reply(
      session.language === 'en'
        ? 'The symptom assessment is not available right now. If you are worried about ' +
          'anything, please go to the nearest health facility.'
        : 'Di assessment no dey available now. If anything dey worry you, abeg go health ' +
          'centre wey dey near you.',
    );
    return;
  }

  const history = await deps.messages.recentForSession(
    session.id,
    deps.transcriptWindow ?? 20,
  );

  const transcript = history.map((m) => ({
    role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: m.body_redacted,
  }));

  const outcome = await runAssessmentTurn(deps.assessment, {
    pathway: session.pathway,
    language: session.language,
    knownSlots: session.slots,
    currentUrgency: session.urgency_current,
    transcript,
    message: msg.text,
  });

  await deps.sessions.mergeSlots(session.id, outcome.slots);
  if (outcome.urgency) await deps.sessions.raiseUrgency(session.id, outcome.urgency);

  if (outcome.decision) {
    if (deps.outcomes) {
      await deps.outcomes.record({
        sessionId: session.id,
        pathway: session.pathway,
        urgency: outcome.decision.urgency,
        urgencyLlm: outcome.decision.urgencyLlm,
        urgencyRules: outcome.decision.urgencyRules,
        escalatedBy: outcome.decision.escalatedBy,
        redFlags: outcome.decision.redFlags,
        slots: outcome.decision.slots,
        citations: outcome.decision.citations,
        rationale: outcome.decision.result.rationale,
        model: outcome.decision.model,
        promptVersion: outcome.decision.promptVersion,
        inputTokens: outcome.decision.inputTokens,
        outputTokens: outcome.decision.outputTokens,
        latencyMs: outcome.decision.latencyMs,
      });
    }

    // The model is authoritative on language once an assessment is under way; the
    // heuristic used before this point only had to get the consent message right.
    const detected = outcome.decision.result.detected_language as Language;
    if (detected !== session.language) {
      await deps.sessions.setLanguage(session.id, detected);
    }
  }

  if (outcome.safetyCheckEscalated) {
    await deps.audit.record('SAFETY_CHECK_ESCALATED', { to: outcome.urgency }, session.id);
  }
  if (outcome.fallbackReason) {
    await deps.audit.record('LLM_FAILOVER', { reason: outcome.fallbackReason }, session.id);
  }
  if (outcome.state === 'escalated') {
    await deps.audit.record('EMERGENCY_ISSUED', { via: 'assessment' }, session.id);
  }

  // WHO IMCI prescribes fixed follow-up intervals for the yellow classifications.
  // Advising her to come back with no way to reach her would make that advice
  // decorative.
  if (deps.followUps && outcome.urgency) {
    if (outcome.state === 'escalated') {
      // She has been told to go now. A reminder in two days would read as though the
      // referral were optional.
      const cancelled = await deps.followUps.cancelForSession(
        session.id,
        'superseded by an emergency referral',
      );
      if (cancelled > 0) {
        deps.logger.info({ sessionId: session.id, cancelled }, 'follow-ups cancelled');
      }
    } else if (outcome.state === 'completed') {
      const plan = planFollowUp({
        urgency: outcome.urgency,
        pathway: session.pathway,
        slots: outcome.slots,
      });
      if (plan) {
        const registration = deps.registrations
          ? await deps.registrations.findByIdentity(
              hashIdentity(msg.channel, msg.from, deps.pepper),
            )
          : null;

        await deps.followUps.schedule({
          sessionId: session.id,
          identityHash: hashIdentity(msg.channel, msg.from, deps.pepper),
          recipient: msg.from,
          channel: msg.channel,
          language: session.language,
          displayName: registration?.display_name ?? null,
          reason: plan.reason,
          intervalDays: plan.intervalDays,
          dueAt: dueAt(plan, new Date()),
        });
        deps.logger.info(
          { sessionId: session.id, reason: plan.reason, days: plan.intervalDays },
          'follow-up scheduled',
        );
      }
    }
  }

  await deps.sessions.setState(session.id, outcome.state);

  for (const body of outcome.messages) {
    await reply(body);
  }

  deps.logger.info(
    {
      sessionId: session.id,
      urgency: outcome.urgency,
      state: outcome.state,
      escalatedBy: outcome.decision?.escalatedBy ?? null,
      latencyMs: Date.now() - receivedAt,
    },
    'assessment turn complete',
  );
}

async function handleConsent(
  deps: HandlerDeps,
  session: SessionRow,
  msg: InboundMessage,
  reply: (body: string) => Promise<void>,
  receivedAt: number,
): Promise<void> {
  const said = msg.text.trim().toLowerCase();
  // '1'/'2' are accepted because a transport without interactive buttons renders the
  // options as a numbered list (see renderOptionsAsText). The numbering there and the
  // matching here must stay in step.
  const accepted =
    msg.replyId === CONSENT_ACCEPT_ID ||
    /^(yes|y|ok|okay|agree|i agree|continue|yes continue|gree|i gree|1)$/i.test(said);
  const declined =
    msg.replyId === CONSENT_DECLINE_ID ||
    /^(no|n|no thanks|no thank you|stop|2)$/i.test(said);

  if (accepted) {
    await deps.sessions.recordConsent(session.id);
    await deps.audit.record('CONSENT_GIVEN', {}, session.id);
    await deps.whatsapp.sendOptions(msg.from, PATHWAY_PROMPT[session.language], [
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
    msg.replyId === PATHWAY_MOTHER_ID ||
    /\b(me|mother|mama|myself|my ?self)\b/i.test(said) ||
    said === '1';
  const neonatal =
    msg.replyId === PATHWAY_BABY_ID ||
    /\b(baby|pikin|child|newborn|my baby)\b/i.test(said) ||
    said === '2';

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

  const acknowledgement =
    chosen === 'neonatal'
      ? session.language === 'en'
        ? 'Thank you. I will ask a few questions about your baby.'
        : 'Thank you. I go ask small questions about your pikin.'
      : session.language === 'en'
        ? 'Thank you. I will ask a few questions about how you are feeling.'
        : 'Thank you. I go ask small questions about how you dey feel.';

  // Ask the opening question in the same turn.
  //
  // Without it the acknowledgement promises questions and then sends none, leaving the
  // mother with nothing to answer and no way to tell whether to wait or to type. That is
  // the worst moment to be ambiguous, because the entire assessment is still ahead of her.
  //
  // Scripted on purpose, and the one place that is right. No symptom has been described
  // yet, so there is nothing for the model to adapt to — and asking it in code means the
  // conversation still starts when the model is unavailable. Every later question is
  // still the model's, phrased around what she actually said.
  const first = nextDomain(chosen, {});
  await reply(
    first ? `${acknowledgement}\n\n${first.fallbackQuestion[session.language]}` : acknowledgement,
  );
}
