/**
 * Evaluation scenario format and loader.
 *
 * A scenario is a simulated clinical vignette with a clinician-adjudicated gold-standard
 * urgency. Scenarios are authored in YAML so a clinical reviewer can read and edit them
 * without touching code — they are review artefacts as much as test fixtures.
 *
 * The schema is validated on load and validation failures are fatal. An unadjudicated or
 * malformed scenario silently skewing an accuracy figure is worse than a crash.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { URGENCY_VALUES } from '../types';

export const ScenarioSchema = z
  .object({
    /** Stable ID, e.g. NEO-014. Used as the key in eval_results. */
    id: z.string().regex(/^[A-Z]{2,4}-\d{2,4}$/, 'id must look like NEO-014 or ADV-001'),
    pathway: z.enum(['maternal', 'neonatal']),
    language: z.enum(['en', 'pcm']),

    /**
     * Prompts are iterated against `dev` and reported on `holdout`. `smoke` is the small
     * CI subset. Tuning on the reported set is the commonest methodological error in work
     * of this kind, so the split is part of the scenario, not a runner flag.
     */
    split: z.enum(['dev', 'holdout', 'smoke']),

    gold_urgency: z.enum(URGENCY_VALUES as unknown as [string, ...string[]]),
    /** Guideline section the gold standard is traced to. */
    gold_source: z.string().min(3),
    /** Reviewer IDs who adjudicated this scenario. At least one required. */
    adjudicated_by: z.array(z.string().min(1)).min(1),

    /** Free-form clinical profile, for the reviewer's benefit. Not sent to the system. */
    profile: z.record(z.string(), z.unknown()).optional(),

    /** The mother's messages, in order. */
    turns: z.array(z.string().min(1)).min(1).max(20),

    expect: z
      .object({
        /** Any of these red-flag IDs firing counts as correct detection. */
        red_flags_any_of: z.array(z.string()).optional(),
        /**
         * Phrases that must appear somewhere in the system's replies.
         *
         * Plain substring match, case-insensitive. Avoid phrases the standing disclaimer
         * already contains ("health facility") — those pass trivially on every reply.
         */
        must_mention: z.array(z.string()).optional(),
        /**
         * Phrases that must NOT appear.
         *
         * Plain substring match, so forbid the harmful *phrasing* rather than a bare
         * word: "wait" alone fails a correct emergency reply, because the advice
         * legitimately reads "do not wait to see if it improves". Prefer "wait and see".
         */
        must_not_mention: z.array(z.string()).optional(),
      })
      .optional(),

    /** Set for adversarial scenarios so they can be reported separately. */
    adversarial: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
}

/** Parse and validate one scenario file. */
export function parseScenario(yaml: string, source: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    throw new ScenarioError(
      `${source}: invalid YAML — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ScenarioError(`${source}: ${problems}`);
  }

  return parsed.data;
}

/** Recursively load every `.yaml`/`.yml` scenario under `dir`. */
export function loadScenarios(dir: string): Scenario[] {
  const files: string[] = [];

  const walk = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (['.yaml', '.yml'].includes(extname(entry).toLowerCase())) {
        files.push(full);
      }
    }
  };
  walk(dir);

  const scenarios = files.map((f) => parseScenario(readFileSync(f, 'utf8'), f));

  const seen = new Map<string, string>();
  scenarios.forEach((s, i) => {
    const previous = seen.get(s.id);
    if (previous) {
      throw new ScenarioError(`duplicate scenario id ${s.id} in ${files[i]} and ${previous}`);
    }
    seen.set(s.id, files[i]!);
  });

  return scenarios;
}

export function filterBySplit(scenarios: readonly Scenario[], split: string): Scenario[] {
  return scenarios.filter((s) => s.split === split);
}

/**
 * Report the composition of a scenario set.
 *
 * A bank with only two emergency cases cannot support a meaningful under-triage rate, so
 * the balance is worth stating in Chapter 4 alongside the results.
 */
export function describeBank(scenarios: readonly Scenario[]): {
  total: number;
  bySplit: Record<string, number>;
  byPathway: Record<string, number>;
  byLanguage: Record<string, number>;
  byGold: Record<string, number>;
  adversarial: number;
} {
  const count = (fn: (s: Scenario) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of scenarios) out[fn(s)] = (out[fn(s)] ?? 0) + 1;
    return out;
  };

  return {
    total: scenarios.length,
    bySplit: count((s) => s.split),
    byPathway: count((s) => s.pathway),
    byLanguage: count((s) => s.language),
    byGold: count((s) => s.gold_urgency),
    adversarial: scenarios.filter((s) => s.adversarial).length,
  };
}
