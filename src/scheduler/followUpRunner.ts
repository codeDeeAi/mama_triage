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
 * SMS is NOT used here, and the reason is worth stating: the system hashes phone numbers
 * irreversibly, so it cannot send an SMS to a registrant even though the SMS API works.
 * That is a genuine consequence of the privacy design rather than an oversight — sending
 * SMS reminders would require storing recoverable numbers, which is a decision for the
 * researcher and their ethics reviewer, not a default.
 */

import { followUpMessage } from '../orchestrator/followUp';
import { templateIdFor } from '../whatsapp/templates';
import type { FollowUpRepository, FollowUpRow } from '../db/repositories/followup.repo';
import type { MessageTransport } from '../whatsapp/transport';
import type { Logger } from '../telemetry/logger';
import type { Language } from '../types';

export interface FollowUpRunnerDeps {
  followUps: FollowUpRepository;
  /** One transport per channel, keyed as in the bootstrap. */
  transports: Map<string, MessageTransport>;
  logger: Logger;
  studyName?: string;
}

export interface RunResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** One pass over the due queue. */
export async function runFollowUps(
  deps: FollowUpRunnerDeps,
  now: Date = new Date(),
): Promise<RunResult> {
  const due = await deps.followUps.claimDue(50, now);
  const result: RunResult = { claimed: due.length, sent: 0, failed: 0, skipped: 0 };

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
