/**
 * Follow-up delivery.
 *
 * Polls for due reminders and sends each on the channel the mother already uses.
 *
 * Channel choice is deliberate. Telegram permits free text to anyone who has started the
 * bot, so a reminder costs nothing and needs no template. WhatsApp requires an approved
 * template once the 24-hour session window has closed, which is precisely why
 * `mama_triage_followup_*` exists.
 *
 * SMS is sent IN ADDITION to the chat reminder, and only for registrants who explicitly
 * opted in and gave a number. It is not a substitute: SMS cannot receive her reply, so
 * the chat message is what lets her actually come back. What SMS adds is reach — it
 * arrives on a feature phone with no data connection, which neither chat channel can do.
 *
 * A failed SMS never fails the follow-up. The reminder that matters is the one she can
 * reply to.
 */

import { followUpMessage } from '../orchestrator/followUp';
import { templateIdFor } from '../whatsapp/templates';
import type { FollowUpRepository, FollowUpRow } from '../db/repositories/followup.repo';
import type { MessageTransport } from '../whatsapp/transport';
import type { Logger } from '../telemetry/logger';
import type { Language } from '../types';
import type { SmsNotifier } from '../sms/notifier';
import { followUpSms } from '../sms/notifier';
import type { RegistrationRepository } from '../db/repositories/registration.repo';

export interface FollowUpRunnerDeps {
  followUps: FollowUpRepository;
  /** One transport per channel, keyed as in the bootstrap. */
  transports: Map<string, MessageTransport>;
  logger: Logger;
  /** Optional: sends the extra SMS reminder for registrants who opted in. */
  sms?: SmsNotifier;
  registrations?: RegistrationRepository;
  studyName?: string;
}

export interface RunResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Extra SMS copies delivered alongside the chat reminder. */
  smsSent: number;
}

/** One pass over the due queue. */
export async function runFollowUps(
  deps: FollowUpRunnerDeps,
  now: Date = new Date(),
): Promise<RunResult> {
  const due = await deps.followUps.claimDue(50, now);
  const result: RunResult = { claimed: due.length, sent: 0, failed: 0, skipped: 0, smsSent: 0 };

  for (const row of due) {
    const transport = deps.transports.get(row.channel);
    if (!transport) {
      result.skipped += 1;
      await deps.followUps.markFailed(
        row.id,
        `channel ${row.channel} is not configured on this deployment`,
      );
      continue;
    }

    const to = row.recipient;
    if (!to) {
      // The address has already been discarded, so this can never be delivered. Counted
      // rather than retried forever.
      result.skipped += 1;
      await deps.followUps.markFailed(row.id, 'no deliverable address on the record');
      continue;
    }

    try {
      if (transport.capabilities.freeTextOutbound) {
        await transport.sendText(to, followUpMessage(row.display_name, row.language as Language));
      } else {
        // WhatsApp outside the 24-hour window: only an approved template may be sent.
        await transport.sendTemplate(to, {
          template: templateIdFor(transport.capabilities.provider, 'followup', row.language as Language),
          params: [row.display_name ?? 'there', `${row.interval_days} days`],
          language: row.language,
        });
      }

      await deps.followUps.markSent(row.id);
      result.sent += 1;

      // Additional reach for anyone who asked for it. Attempted after the chat reminder
      // has already succeeded, and never allowed to fail the follow-up: the message she
      // can reply to is the one that matters.
      if (deps.sms && deps.registrations) {
        try {
          const reg = await deps.registrations.findByIdentity(row.identity_hash);
          if (reg?.sms_number) {
            await deps.sms.send(
              reg.sms_number,
              followUpSms(
                row.display_name ?? 'there',
                row.language as Language,
                row.channel === 'telegram' ? 'Telegram' : 'WhatsApp',
              ),
            );
            result.smsSent += 1;
          }
        } catch (err) {
          deps.logger.warn({ followUpId: row.id, err }, 'extra SMS reminder failed');
        }
      }
      deps.logger.info(
        { followUpId: row.id, channel: row.channel, reason: row.reason },
        'follow-up sent',
      );
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await deps.followUps.markFailed(row.id, message);
      deps.logger.error({ followUpId: row.id, err }, 'follow-up delivery failed');
    }
  }

  return result;
}

/**
 * Start the periodic runner.
 *
 * The interval is deliberately coarse. Follow-ups are due on a scale of days, so checking
 * every few minutes is ample and keeps the query off the database the rest of the time.
 */
export function startFollowUpRunner(
  deps: FollowUpRunnerDeps,
  intervalMs = 5 * 60 * 1000,
): { stop: () => void } {
  const timer = setInterval(() => {
    void runFollowUps(deps)
      .then((r) => {
        if (r.claimed > 0) deps.logger.info(r, 'follow-up run complete');
      })
      .catch((err: unknown) => deps.logger.error({ err }, 'follow-up run failed'));
  }, intervalMs);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
