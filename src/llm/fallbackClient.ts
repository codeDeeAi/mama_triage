/**
 * Try the primary provider; use the standby when it cannot answer.
 *
 * Which failures fall through is the whole design of this file.
 *
 * **Availability failures fall through.** A timeout, a 5xx, an open circuit breaker, an
 * exhausted credit balance — none of these say anything about the request. Another
 * provider will very likely answer it, and the alternative is the static fallback message,
 * which helps a mother far less than an assessment does.
 *
 * **Contract failures do not.** If the primary returned output that failed schema or
 * citation validation, the request itself is suspect: an ambiguous transcript, a retrieval
 * set with nothing relevant in it, a prompt the situation does not fit. Sending that to a
 * second model is not a fix, it is a second guess — and the more capable model has already
 * declined. Falling through on `invalid_output` would systematically route the hardest
 * cases to the weaker model, which is exactly backwards for a triage system.
 *
 * The standby is a standby. It is not tried first, not load-balanced against, and every
 * use is audited, so an evaluation can report how many decisions came from each model
 * rather than averaging over both and describing neither.
 */

import { LlmError, type ToolCallRequest, type ToolCallResult } from './anthropic';
import type { ToolCallClient } from './client';

export interface FallbackLlmClientOptions {
  primary: ToolCallClient;
  standby: ToolCallClient;
  /** Called when the standby is used, and when it also fails. */
  onFallback?: (detail: { reason: string; error: string; recovered: boolean }) => void;
}

/** Failures that say "this provider cannot answer right now", not "this request is bad". */
export function isAvailabilityFailure(err: unknown): boolean {
  if (!(err instanceof LlmError)) {
    // An unrecognised error is a transport or runtime problem rather than a rejected
    // request — the providers raise LlmError for anything they understood.
    return true;
  }
  return err.kind === 'timeout' || err.kind === 'api_error' || err.kind === 'circuit_open';
}

export class FallbackLlmClient implements ToolCallClient {
  constructor(private readonly opts: FallbackLlmClientOptions) {}

  async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
    try {
      return await this.opts.primary.callTool(req);
    } catch (err) {
      if (!isAvailabilityFailure(err)) throw err;

      const reason = err instanceof LlmError ? err.kind : 'unknown';
      const error = err instanceof Error ? err.message : String(err);

      try {
        const result = await this.opts.standby.callTool(req);
        this.opts.onFallback?.({ reason, error, recovered: true });
        return result;
      } catch (standbyErr) {
        this.opts.onFallback?.({ reason, error, recovered: false });
        // Surface the standby's failure. The primary's is already recorded above, and
        // this is the error that actually ended the attempt.
        throw standbyErr;
      }
    }
  }
}
