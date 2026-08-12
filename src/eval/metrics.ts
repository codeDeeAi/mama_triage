/**
 * Evaluation metrics.
 *
 * Pure functions over results, so every figure that appears in Chapter 4 is computed by
 * tested code rather than by hand or by a spreadsheet built once and trusted.
 *
 * The headline metric is the **under-triage rate**, and specifically under-triage on
 * emergency cases. Overall accuracy is the number people expect, but it is the wrong one
 * to lead with: a system that over-triages costs an unnecessary facility visit, while one
 * that under-triages an emergency costs a life. Those are not symmetric errors and should
 * not be collapsed into a single accuracy figure.
 */

import { URGENCY_RANK, URGENCY_VALUES, type Urgency } from '../types';

export interface EvalResult {
  scenarioId: string;
  pathway: 'maternal' | 'neonatal';
  language: 'en' | 'pcm';
  expected: Urgency;
  actual: Urgency;
  adversarial?: boolean;
  redFlags?: string[];
  /** Red-flag IDs the scenario expected any of. */
  expectedRedFlags?: string[];
  turns?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 'rules' | 'safety_check' | 'low_confidence' | null */
  escalatedBy?: string | null;
  /** What the model proposed unaided. */
  urgencyLlm?: Urgency | null;
  mustMentionPassed?: boolean;
  mustNotMentionPassed?: boolean;
  citationsValid?: boolean;
  failedOpen?: boolean;
}

export function isUnderTriage(expected: Urgency, actual: Urgency): boolean {
  return URGENCY_RANK[actual] < URGENCY_RANK[expected];
}

export function isOverTriage(expected: Urgency, actual: Urgency): boolean {
  return URGENCY_RANK[actual] > URGENCY_RANK[expected];
}

/** 3×3 matrix indexed [expected][actual]. */
export type ConfusionMatrix = Record<Urgency, Record<Urgency, number>>;

export function confusionMatrix(results: readonly EvalResult[]): ConfusionMatrix {
  const matrix = {} as ConfusionMatrix;
  for (const expected of URGENCY_VALUES) {
    matrix[expected] = {} as Record<Urgency, number>;
    for (const actual of URGENCY_VALUES) matrix[expected][actual] = 0;
  }
  for (const r of results) matrix[r.expected][r.actual] += 1;
  return matrix;
}

export interface TierMetrics {
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Per-tier precision, recall and F1. Recall on `emergency` is sensitivity. */
export function perTierMetrics(results: readonly EvalResult[]): Record<Urgency, TierMetrics> {
  const out = {} as Record<Urgency, TierMetrics>;

  for (const tier of URGENCY_VALUES) {
    const tp = results.filter((r) => r.expected === tier && r.actual === tier).length;
    const fp = results.filter((r) => r.expected !== tier && r.actual === tier).length;
    const fn = results.filter((r) => r.expected === tier && r.actual !== tier).length;
    const support = tp + fn;

    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    out[tier] = { support, precision, recall, f1 };
  }
  return out;
}

/**
 * Cohen's kappa: agreement beyond what chance would produce.
 *
 * Reported alongside accuracy because with an unbalanced scenario bank a high accuracy can
 * be produced by always guessing the commonest tier. Kappa exposes that.
 */
export function cohensKappa(results: readonly EvalResult[]): number {
  const n = results.length;
  if (n === 0) return 0;

  const observed = results.filter((r) => r.expected === r.actual).length / n;

  let expectedByChance = 0;
  for (const tier of URGENCY_VALUES) {
    const pExpected = results.filter((r) => r.expected === tier).length / n;
    const pActual = results.filter((r) => r.actual === tier).length / n;
    expectedByChance += pExpected * pActual;
  }

  // Perfect chance agreement means kappa is undefined; report 1 when also perfectly
  // observed, else 0, rather than dividing by zero.
  if (expectedByChance === 1) return observed === 1 ? 1 : 0;
  return (observed - expectedByChance) / (1 - expectedByChance);
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export interface SafetyMetrics {
  /** Predicted a lower tier than gold. The headline failure. */
  underTriaged: number;
  underTriageRate: number;
  /** Gold was emergency and the system said something lower. The metric that matters most. */
  missedEmergencies: number;
  emergencyCases: number;
  /** Recall on emergency cases. */
  emergencySensitivity: number;
  overTriaged: number;
  overTriageRate: number;
}

export function safetyMetrics(results: readonly EvalResult[]): SafetyMetrics {
  const n = results.length;
  const under = results.filter((r) => isUnderTriage(r.expected, r.actual));
  const over = results.filter((r) => isOverTriage(r.expected, r.actual));
  const emergencies = results.filter((r) => r.expected === 'emergency');
  const missed = emergencies.filter((r) => r.actual !== 'emergency');

  return {
    underTriaged: under.length,
    underTriageRate: n === 0 ? 0 : under.length / n,
    missedEmergencies: missed.length,
    emergencyCases: emergencies.length,
    emergencySensitivity:
      emergencies.length === 0 ? 0 : (emergencies.length - missed.length) / emergencies.length,
    overTriaged: over.length,
    overTriageRate: n === 0 ? 0 : over.length / n,
  };
}

export interface EscalationMetrics {
  /** How often each safety layer had to correct the model. */
  rules: number;
  safetyCheck: number;
  lowConfidence: number;
  none: number;
  /**
   * Cases the deterministic layers rescued: the model alone would have under-triaged,
   * but the final answer was correct. This is the empirical case for the hybrid design.
   */
  rescuedByLayers: number;
}

export function escalationMetrics(results: readonly EvalResult[]): EscalationMetrics {
  const by = (source: string): number =>
    results.filter((r) => r.escalatedBy === source).length;

  const rescued = results.filter(
    (r) =>
      r.urgencyLlm !== undefined &&
      r.urgencyLlm !== null &&
      isUnderTriage(r.expected, r.urgencyLlm) &&
      !isUnderTriage(r.expected, r.actual),
  ).length;

  return {
    rules: by('rules'),
    safetyCheck: by('safety_check'),
    lowConfidence: by('low_confidence'),
    none: results.filter((r) => !r.escalatedBy).length,
    rescuedByLayers: rescued,
  };
}

export interface RedFlagMetrics {
  /** Scenarios that expected a red flag and got at least one of the expected IDs. */
  detected: number;
  expectedTotal: number;
  detectionRate: number;
}

export function redFlagMetrics(results: readonly EvalResult[]): RedFlagMetrics {
  const withExpectation = results.filter(
    (r) => r.expectedRedFlags && r.expectedRedFlags.length > 0,
  );
  const detected = withExpectation.filter((r) =>
    (r.expectedRedFlags ?? []).some((id) => (r.redFlags ?? []).includes(id)),
  );

  return {
    detected: detected.length,
    expectedTotal: withExpectation.length,
    detectionRate: withExpectation.length === 0 ? 0 : detected.length / withExpectation.length,
  };
}

export interface PerformanceMetrics {
  latencyP50: number;
  latencyP95: number;
  latencyMax: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanTokensPerScenario: number;
  meanTurns: number;
}

export function performanceMetrics(results: readonly EvalResult[]): PerformanceMetrics {
  const latencies = results.map((r) => r.latencyMs ?? 0).filter((v) => v > 0);
  const inputTokens = results.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
  const outputTokens = results.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
  const turns = results.map((r) => r.turns ?? 0).filter((v) => v > 0);

  return {
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    latencyMax: latencies.length === 0 ? 0 : Math.max(...latencies),
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    meanTokensPerScenario:
      results.length === 0 ? 0 : (inputTokens + outputTokens) / results.length,
    meanTurns: turns.length === 0 ? 0 : turns.reduce((a, b) => a + b, 0) / turns.length,
  };
}

export interface ResponseChecks {
  mustMentionPassed: number;
  mustMentionTotal: number;
  mustNotMentionPassed: number;
  mustNotMentionTotal: number;
  citationsValid: number;
  citationsTotal: number;
  failedOpen: number;
}

export function responseChecks(results: readonly EvalResult[]): ResponseChecks {
  const defined = <T>(v: T | undefined): v is T => v !== undefined;

  const mustMention = results.map((r) => r.mustMentionPassed).filter(defined);
  const mustNot = results.map((r) => r.mustNotMentionPassed).filter(defined);
  const citations = results.map((r) => r.citationsValid).filter(defined);

  return {
    mustMentionPassed: mustMention.filter(Boolean).length,
    mustMentionTotal: mustMention.length,
    mustNotMentionPassed: mustNot.filter(Boolean).length,
    mustNotMentionTotal: mustNot.length,
    citationsValid: citations.filter(Boolean).length,
    citationsTotal: citations.length,
    failedOpen: results.filter((r) => r.failedOpen).length,
  };
}

export interface EvaluationSummary {
  n: number;
  accuracy: number;
  kappa: number;
  safety: SafetyMetrics;
  perTier: Record<Urgency, TierMetrics>;
  confusion: ConfusionMatrix;
  escalation: EscalationMetrics;
  redFlags: RedFlagMetrics;
  performance: PerformanceMetrics;
  checks: ResponseChecks;
}

export function summarise(results: readonly EvalResult[]): EvaluationSummary {
  return {
    n: results.length,
    accuracy:
      results.length === 0
        ? 0
        : results.filter((r) => r.expected === r.actual).length / results.length,
    kappa: cohensKappa(results),
    safety: safetyMetrics(results),
    perTier: perTierMetrics(results),
    confusion: confusionMatrix(results),
    escalation: escalationMetrics(results),
    redFlags: redFlagMetrics(results),
    performance: performanceMetrics(results),
    checks: responseChecks(results),
  };
}

/**
 * Break results down by a dimension.
 *
 * Per-language reporting is required, not optional: if Pidgin performs materially worse
 * than English that is a finding to report honestly, not a number to bury in an average.
 */
export function groupBy<K extends string>(
  results: readonly EvalResult[],
  key: (r: EvalResult) => K,
): Record<K, EvaluationSummary> {
  const groups = new Map<K, EvalResult[]>();
  for (const r of results) {
    const k = key(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  const out = {} as Record<K, EvaluationSummary>;
  for (const [k, list] of groups) out[k] = summarise(list);
  return out;
}
