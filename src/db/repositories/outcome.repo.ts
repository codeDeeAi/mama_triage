/**
 * Triage outcome repository.
 *
 * Records what the mother was told, alongside what each layer independently proposed.
 * The disagreement between `urgency_llm` and `urgency_rules` is a reportable finding and
 * the empirical justification for the hybrid architecture (plan §13.3).
 */

import type { Db } from '../pool';
import type { Pathway, RedFlagHit, Slots, Urgency } from '../../types';

export interface RecordOutcomeInput {
  sessionId: string;
  pathway: Pathway;
  urgency: Urgency;
  urgencyLlm: Urgency | null;
  urgencyRules: Urgency | null;
  escalatedBy: string | null;
  redFlags: RedFlagHit[];
  slots: Slots;
  citations: Array<{ chunk_id: string; claim: string }>;
  rationale: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface OutcomeRow {
  id: string;
  session_id: string;
  pathway: Pathway;
  urgency: Urgency;
  urgency_llm: Urgency | null;
  urgency_rules: Urgency | null;
  escalated_by: string | null;
  created_at: Date;
}

export class OutcomeRepository {
  constructor(private readonly db: Db) {}

  async record(input: RecordOutcomeInput): Promise<OutcomeRow> {
    const row = await this.db.one<OutcomeRow>(
      `INSERT INTO triage_outcomes
         (session_id, pathway, urgency, urgency_llm, urgency_rules, escalated_by,
          red_flags, slots, citations, rationale, model, prompt_version,
          input_tokens, output_tokens, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.sessionId,
        input.pathway,
        input.urgency,
        input.urgencyLlm,
        input.urgencyRules,
        input.escalatedBy,
        JSON.stringify(input.redFlags),
        JSON.stringify(input.slots),
        JSON.stringify(input.citations),
        input.rationale,
        input.model,
        input.promptVersion,
        input.inputTokens,
        input.outputTokens,
        input.latencyMs,
      ],
    );
    if (!row) throw new Error('failed to record triage outcome');
    return row;
  }

  async listForSession(sessionId: string): Promise<OutcomeRow[]> {
    return this.db.query<OutcomeRow>(
      `SELECT * FROM triage_outcomes WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
  }

  /**
   * How often each layer escalated the other.
   *
   * This query produces a figure for Chapter 4: if the rules never escalate the model,
   * the deterministic layer is redundant; if they escalate often, the hybrid design is
   * carrying real safety weight.
   */
  async disagreementStats(): Promise<{
    total: number;
    rulesEscalated: number;
    safetyCheckEscalated: number;
    lowConfidencePromoted: number;
  }> {
    const row = await this.db.one<{
      total: string;
      rules: string;
      safety: string;
      low_conf: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE escalated_by = 'rules')::text AS rules,
              count(*) FILTER (WHERE escalated_by = 'safety_check')::text AS safety,
              count(*) FILTER (WHERE escalated_by = 'low_confidence')::text AS low_conf
         FROM triage_outcomes`,
    );
    return {
      total: Number(row?.total ?? 0),
      rulesEscalated: Number(row?.rules ?? 0),
      safetyCheckEscalated: Number(row?.safety ?? 0),
      lowConfidencePromoted: Number(row?.low_conf ?? 0),
    };
  }
}
