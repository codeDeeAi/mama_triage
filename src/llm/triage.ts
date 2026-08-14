/**
 * Triage orchestration.
 *
 * This is where the model's proposal is turned into a decision that may be shown to a
 * mother. Nothing the model returns is trusted until it has passed, in order:
 *
 *   1. schema validation          — malformed output is unusable, not "mostly fine"
 *   2. citation validation        — a cited chunk must be one the model was actually shown
 *   3. deterministic red flags    — the rules layer may RAISE urgency, never lower it
 *   4. low-confidence promotion   — an uncertain "stay home" is the failure that kills
 *   5. session ratchet            — urgency may never fall within a conversation
 *
 * Each step is recorded, so the evaluation can report how often each one fired. The
 * rules-vs-LLM disagreement rate is the empirical justification for the hybrid design.
 */

import { readFileSync } from 'node:fs';
import { evaluateRedFlags } from '../safety/redFlags';
import { ratchet } from '../safety/ratchet';
import { renderContext, type RetrievalOutcome } from '../rag/retrieve';
import type { Pathway, RedFlagHit, Slots, Urgency } from '../types';
import { LlmError } from './anthropic';
import type { ToolCallClient } from './client';
import { TriageResult, triageToolSchema } from './schema';

export type EscalationSource = 'rules' | 'safety_check' | 'low_confidence' | null;

export interface TriageDecision {
  /** Final urgency, after every check. This is what the mother is told. */
  urgency: Urgency;
  /** What the model proposed on its own. */
  urgencyLlm: Urgency;
  /** What the deterministic rules said on their own, or null if nothing fired. */
  urgencyRules: Urgency | null;
  escalatedBy: EscalationSource;
  result: TriageResult;
  redFlags: RedFlagHit[];
  slots: Slots;
  citations: Array<{ chunk_id: string; claim: string }>;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** True when retrieval found nothing above the similarity floor. */
  ungrounded: boolean;
}

export interface TriageRequest {
  pathway: Pathway;
  /** Slots already established in this session. */
  knownSlots: Slots;
  /** Session urgency high-water mark. */
  currentUrgency: Urgency | null;
  /** Conversation so far, oldest first. */
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
  retrieval: RetrievalOutcome;
}

export interface TriageServiceOptions {
  client: ToolCallClient;
  model: string;
  maxTokens: number;
  promptVersion: string;
  /** Defaults to reading prompts/system.triage.v1.md. */
  systemPrompt?: string;
  promptPath?: string;
  onAudit?: (event: string, detail: Record<string, unknown>) => void;
}

const TOOL_NAME = 'record_triage';
const TOOL_DESCRIPTION =
  'Record the structured triage assessment for this turn. This is the only way to respond.';

export class TriageService {
  private readonly client: ToolCallClient;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly systemPrompt: string;
  readonly promptVersion: string;
  private readonly onAudit: (event: string, detail: Record<string, unknown>) => void;

  constructor(opts: TriageServiceOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.promptVersion = opts.promptVersion;
    this.systemPrompt =
      opts.systemPrompt ??
      readFileSync(opts.promptPath ?? 'prompts/system.triage.v1.md', 'utf8');
    this.onAudit = opts.onAudit ?? (() => undefined);
  }

  /**
   * Run one triage turn.
   *
   * @throws {LlmError} when the model cannot produce a usable result after one retry.
   *   The caller must then send the static fallback (src/safety/fallback.ts).
   */
  async assess(req: TriageRequest): Promise<TriageDecision> {
    const context = renderContext(req.retrieval.results);
    const messages = this.buildMessages(req, context);

    let result: TriageResult | undefined;
    let call: Awaited<ReturnType<ToolCallClient['callTool']>> | undefined;
    let lastProblem = '';

    // One retry: a schema or citation failure is often a one-off, but a second failure
    // means the model cannot satisfy the contract and the fallback is the safe answer.
    for (let attempt = 0; attempt < 2; attempt++) {
      call = await this.client.callTool({
        model: this.model,
        system: this.systemPrompt,
        messages:
          attempt === 0
            ? messages
            : [
                ...messages,
                {
                  role: 'user' as const,
                  content:
                    `Your previous response was rejected: ${lastProblem}. ` +
                    `Call ${TOOL_NAME} again, satisfying the schema exactly and citing ` +
                    `only chunk_ids from the context blocks above.`,
                },
              ],
        toolName: TOOL_NAME,
        toolDescription: TOOL_DESCRIPTION,
        toolSchema: triageToolSchema(),
        maxTokens: this.maxTokens,
        cacheSystemPrompt: true,
      });

      const parsed = TriageResult.safeParse(call.input);
      if (!parsed.success) {
        lastProblem = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .slice(0, 5)
          .join('; ');
        this.onAudit('LLM_SCHEMA_REJECTED', { attempt, problem: lastProblem });
        continue;
      }

      // A citation naming a chunk the model was never shown is a fabrication: it has
      // invented the support for a clinical claim.
      const shown = new Set(req.retrieval.results.map((r) => r.chunk.chunkId));
      const unknown = parsed.data.citations
        .map((c) => c.chunk_id)
        .filter((id) => !shown.has(id));

      // When retrieval returned nothing there is no valid chunk to cite, so citation
      // validation is skipped — the ungrounded flag is what carries that signal instead.
      if (unknown.length > 0 && shown.size > 0) {
        lastProblem = `cited unknown chunk_id(s): ${unknown.join(', ')}`;
        this.onAudit('CITATION_REJECTED', { attempt, unknown });
        continue;
      }

      result = parsed.data;
      break;
    }

    if (!result || !call) {
      throw new LlmError(
        `model failed the triage contract twice (${lastProblem})`,
        'invalid_output',
      );
    }

    return this.decide(req, result, call);
  }

  private buildMessages(
    req: TriageRequest,
    context: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const state: string[] = [];
    state.push(`PATHWAY: ${req.pathway}`);

    const known = Object.entries(req.knownSlots).filter(([, v]) => v !== undefined);
    state.push(
      known.length > 0
        ? `ALREADY ESTABLISHED (do not ask again): ${known
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ')}`
        : 'ALREADY ESTABLISHED: nothing yet',
    );

    if (req.currentUrgency) {
      state.push(
        `URGENCY ALREADY ASSIGNED THIS SESSION: ${req.currentUrgency}. ` +
          `You may not propose anything less urgent.`,
      );
    }
    if (!req.retrieval.grounded) {
      state.push(
        'WARNING: retrieval found no well-matching clinical guidance. You are ungrounded. ' +
          'Be more cautious, not less, and say so in your rationale.',
      );
    }

    return [
      {
        role: 'user',
        content:
          `## Retrieved clinical guidance\n\n${context}\n\n` +
          `## Assessment state\n\n${state.join('\n')}\n\n` +
          `## Conversation\n\n${formatTranscript(req.transcript)}`,
      },
    ];
  }

  /** Apply every deterministic check to the model's proposal. */
  private decide(
    req: TriageRequest,
    result: TriageResult,
    call: { inputTokens: number; outputTokens: number; latencyMs: number; model?: string },
  ): TriageDecision {
    const urgencyLlm = result.urgency as Urgency;

    // Merge what the model extracted into what the session already knows, then re-run the
    // deterministic register over the combined state.
    const slots = { ...req.knownSlots, ...(result.extracted_slots as Slots) };
    const rules = evaluateRedFlags({ slots, pathway: req.pathway });
    const urgencyRules = rules.urgency;

    let urgency = urgencyLlm;
    let escalatedBy: EscalationSource = null;

    if (urgencyRules && ratchet(urgency, urgencyRules) !== urgency) {
      urgency = ratchet(urgency, urgencyRules);
      escalatedBy = 'rules';
      this.onAudit('RULES_ESCALATED', {
        from: urgencyLlm,
        to: urgency,
        ids: rules.hits.map((h) => h.id),
      });
    }

    // An uncertain "stay at home" is the exact failure mode that costs lives, and it is
    // worse here than elsewhere because the nearest facility may be hours away.
    if (urgency === 'self_care' && result.confidence === 'low') {
      urgency = 'facility_visit';
      escalatedBy = 'low_confidence';
      this.onAudit('LOW_CONFIDENCE_PROMOTED', { from: 'self_care', to: 'facility_visit' });
    }

    // Finally, the session ratchet. If the model proposed a de-escalation despite being
    // told not to, that is worth recording as a finding.
    const ratcheted = ratchet(req.currentUrgency, urgency);
    if (ratcheted !== urgency) {
      this.onAudit('RATCHET_BLOCKED_DOWNGRADE', {
        proposed: urgency,
        held: ratcheted,
        byModel: urgencyLlm,
      });
      urgency = ratcheted;
    }

    return {
      urgency,
      urgencyLlm,
      urgencyRules,
      escalatedBy,
      result,
      redFlags: rules.hits,
      slots,
      citations: result.citations,
      // What answered, not what was configured. These differ when the standby provider
      // served the request, and the outcome row has to say which model produced the
      // decision or an evaluation cannot separate the two.
      model: call.model || this.model,
      promptVersion: this.promptVersion,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
      ungrounded: !req.retrieval.grounded,
    };
  }
}

export function formatTranscript(
  transcript: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (transcript.length === 0) return '(no messages yet)';
  return transcript
    .map((m) => `${m.role === 'user' ? 'Mother' : 'Assistant'}: ${m.content}`)
    .join('\n');
}
