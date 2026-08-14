/**
 * Second-pass safety check.
 *
 * An independent call, on a different and cheaper model, whose only job is to catch an
 * under-triage the primary assessment missed. It may raise urgency; it can never lower it.
 *
 * Two properties make this worth the cost. First, an independent model is unlikely to make
 * exactly the same omission as the primary — correlated failure is the risk with a single
 * model, and using the same one twice would buy almost nothing. Second, it produces a
 * reportable number for Chapter 4: *how often did the second pass catch something?*
 *
 * It is deliberately fail-open. If the check itself errors, the primary decision stands
 * unchanged — a failing safety net must not block a mother's assessment. The failure is
 * audited so the rate is visible rather than silent.
 */

import { readFileSync } from 'node:fs';
import { isMoreUrgent } from '../safety/ratchet';
import type { Urgency } from '../types';
import type { ToolCallClient } from './client';
import { SafetyVerdict, safetyToolSchema } from './schema';
import { formatTranscript } from './triage';

const TOOL_NAME = 'safety_verdict';
const TOOL_DESCRIPTION =
  'Record whether the proposed urgency should be raised. You may never lower it.';

export interface SafetyCheckResult {
  urgency: Urgency;
  escalated: boolean;
  reason: string | null;
  /** True when the check could not be completed; the primary decision stands. */
  failedOpen: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface SafetyCheckOptions {
  client: ToolCallClient;
  model: string;
  systemPrompt?: string;
  promptPath?: string;
  maxTokens?: number;
  onAudit?: (event: string, detail: Record<string, unknown>) => void;
}

export class SafetyCheckService {
  private readonly client: ToolCallClient;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly onAudit: (event: string, detail: Record<string, unknown>) => void;

  constructor(opts: SafetyCheckOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 300;
    this.systemPrompt =
      opts.systemPrompt ??
      readFileSync(opts.promptPath ?? 'prompts/system.safety-check.v1.md', 'utf8');
    this.onAudit = opts.onAudit ?? (() => undefined);
  }

  async check(input: {
    transcript: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    proposed: Urgency;
    rationale: string;
  }): Promise<SafetyCheckResult> {
    const empty = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };

    try {
      const call = await this.client.callTool({
        model: this.model,
        system: this.systemPrompt,
        messages: [
          {
            role: 'user',
            content:
              `## Conversation\n\n${formatTranscript(input.transcript)}\n\n` +
              `## Assistant's proposed urgency\n\n${input.proposed}\n\n` +
              `## Assistant's reasoning\n\n${input.rationale}`,
          },
        ],
        toolName: TOOL_NAME,
        toolDescription: TOOL_DESCRIPTION,
        toolSchema: safetyToolSchema(),
        maxTokens: this.maxTokens,
        cacheSystemPrompt: true,
      });

      const parsed = SafetyVerdict.safeParse(call.input);
      if (!parsed.success) {
        this.onAudit('SAFETY_CHECK_FAILED', { reason: 'schema', issues: parsed.error.issues.length });
        return { urgency: input.proposed, escalated: false, reason: null, failedOpen: true, ...empty };
      }

      const verdict = parsed.data;

      if (verdict.verdict === 'agree' || !verdict.escalate_to) {
        return {
          urgency: input.proposed,
          escalated: false,
          reason: null,
          failedOpen: false,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          latencyMs: call.latencyMs,
        };
      }

      const target = verdict.escalate_to as Urgency;

      // The prompt forbids de-escalation, but the guarantee must not rest on the model
      // having obeyed it. An "escalation" that is not more urgent is ignored.
      if (!isMoreUrgent(target, input.proposed)) {
        this.onAudit('SAFETY_CHECK_INVALID_ESCALATION', {
          proposed: input.proposed,
          attempted: target,
        });
        return {
          urgency: input.proposed,
          escalated: false,
          reason: null,
          failedOpen: false,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          latencyMs: call.latencyMs,
        };
      }

      this.onAudit('SAFETY_CHECK_ESCALATED', {
        from: input.proposed,
        to: target,
        reason: verdict.reason,
      });

      return {
        urgency: target,
        escalated: true,
        reason: verdict.reason,
        failedOpen: false,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        latencyMs: call.latencyMs,
      };
    } catch (err) {
      // Fail open: a broken safety net must not block the assessment.
      this.onAudit('SAFETY_CHECK_FAILED', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return { urgency: input.proposed, escalated: false, reason: null, failedOpen: true, ...empty };
    }
  }
}
