/**
 * Retrieval.
 *
 * The single most consequential decision here is what text gets embedded as the query.
 *
 * A mother writes "e no dey chop since morning and body dey hot". The corpus is written in
 * clinical English: "the young infant is not able to feed", "fever or low body
 * temperature". Embedding her words directly retrieves poorly, and worst for exactly the
 * Pidgin speakers the system exists to serve.
 *
 * So the query is composed from the *clinical state* — the slots the LLM has extracted,
 * rendered as clinical English — and falls back to the raw message only at the start of a
 * conversation when no slots are filled yet. This is the mechanism by which the system
 * serves Pidgin speakers without needing a Pidgin corpus.
 */

import type { Pathway, Slots } from '../types';
import type { Chunk, SearchResult, VectorStore } from './types';
import type { VoyageEmbedder } from './embed';

export interface RetrievalContext {
  pathway: Pathway;
  slots: Slots;
  /** The mother's latest message, verbatim. */
  message: string;
  /** The assessment domain currently being asked about, if any. */
  activeDomain?: string;
}

export interface RetrievalOutcome {
  results: SearchResult[];
  /** The text actually embedded. Recorded for evaluation and debugging. */
  query: string;
  /**
   * False when nothing retrieved clears the similarity floor. The prompt tells the model
   * it is ungrounded, which makes it MORE cautious, not less — an ungrounded model that
   * confidently reassures is the dangerous failure here.
   */
  grounded: boolean;
  topScore: number;
}

/**
 * Human-readable clinical phrasing for each slot value.
 *
 * These strings are what get embedded, so they are written in the register the guidelines
 * use rather than the register a mother uses.
 */
const SLOT_PHRASES: Record<string, Record<string, string>> = {
  feeding: {
    normal: 'feeding normally',
    reduced: 'reduced feeding, feeding poorly',
    unable_to_feed: 'not able to feed, unable to suck at the breast',
  },
  temperature: {
    normal: 'normal body temperature',
    hot_to_touch: 'fever, hot to touch, raised temperature',
    cold_to_touch: 'low body temperature, hypothermia, cold to touch',
  },
  jaundice: {
    none: 'no jaundice',
    face_only: 'jaundice of the face and eyes',
    to_palms_soles: 'severe jaundice extending to palms and soles',
  },
  breathing: {
    normal: 'normal breathing',
    fast: 'fast breathing, raised respiratory rate',
    chest_indrawing: 'severe chest indrawing',
    grunting_or_apnoea: 'grunting, apnoea, severe respiratory distress, cyanosis',
  },
  activity: {
    alert: 'alert and active',
    less_active: 'less active than usual',
    lethargic_or_unresponsive: 'lethargic, unconscious, unresponsive, movement only when stimulated',
  },
  neonatal_convulsions: { yes: 'convulsions in the young infant', no: 'no convulsions' },
  cord_appearance: {
    normal: 'normal umbilical cord',
    red_or_discharging: 'umbilical redness or discharge, umbilical infection',
  },
  bleeding: {
    normal_lochia: 'normal lochia',
    heavy: 'heavy vaginal bleeding after delivery',
    soaking_pad_hourly: 'postpartum haemorrhage, soaking a pad within an hour',
    clots_with_dizziness: 'passing clots with dizziness, signs of shock',
  },
  fever: {
    none: 'no fever',
    mild: 'mild fever',
    high_with_chills: 'high fever with chills, puerperal sepsis',
  },
  wound: {
    healing: 'wound healing normally',
    painful_or_swollen: 'painful or swollen perineal or caesarean wound',
    discharge_or_foul_odour: 'wound with purulent discharge or foul odour, wound infection',
  },
  breast: {
    normal: 'normal breasts',
    engorged_or_cracked: 'breast engorgement, cracked nipples',
    red_hot_painful_lump: 'mastitis, breast abscess, red hot painful breast lump',
  },
  preeclampsia: {
    none: 'no pre-eclampsia signs',
    headache_or_visual: 'severe headache with visual disturbance',
    severe_epigastric_or_swelling: 'epigastric pain, facial oedema, severe pre-eclampsia',
    convulsion: 'eclampsia, convulsions after delivery',
  },
  mood_concerns: {
    none: '',
    low_mood: 'postnatal low mood',
    severe: 'severe postnatal depression, maternal mental health crisis',
  },
};

/** Compose the text to embed from the current clinical state. */
export function buildQuery(ctx: RetrievalContext): string {
  const parts: string[] = [];

  parts.push(
    ctx.pathway === 'neonatal'
      ? 'newborn young infant assessment'
      : ctx.pathway === 'maternal'
        ? 'postpartum maternal assessment'
        : 'maternal and newborn assessment',
  );

  if (typeof ctx.slots.age_days === 'number') {
    parts.push(`infant aged ${ctx.slots.age_days} days`);
  }
  if (typeof ctx.slots.days_postpartum === 'number') {
    parts.push(`${ctx.slots.days_postpartum} days postpartum`);
  }
  if (ctx.slots.delivery_mode) {
    parts.push(`${ctx.slots.delivery_mode} delivery`);
  }

  for (const [key, value] of Object.entries(ctx.slots)) {
    if (typeof value !== 'string') continue;
    const phrase = SLOT_PHRASES[key]?.[value];
    if (phrase) parts.push(phrase);
  }

  if (ctx.activeDomain) parts.push(ctx.activeDomain);

  // Only fall back to the mother's raw words when there is no clinical state yet —
  // at the very start of an assessment.
  const hasClinicalState = parts.length > 1;
  if (!hasClinicalState && ctx.message.trim().length > 0) {
    parts.push(ctx.message.trim().slice(0, 300));
  }

  return parts.filter((p) => p.length > 0).join('. ');
}

export interface RetrieverOptions {
  topK?: number;
  /**
   * Similarity floor for a result to count as grounding. Tuned during sprint 3 against
   * the probe queries in the evaluation set; the default is deliberately conservative.
   */
  minScore?: number;
}

export class Retriever {
  private readonly topK: number;
  private readonly minScore: number;

  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Pick<VoyageEmbedder, 'embedQuery'>,
    opts: RetrieverOptions = {},
  ) {
    this.topK = opts.topK ?? 5;
    this.minScore = opts.minScore ?? 0.35;
  }

  async retrieve(ctx: RetrievalContext): Promise<RetrievalOutcome> {
    const query = buildQuery(ctx);
    const embedding = await this.embedder.embedQuery(query);

    const results = await this.store.search(embedding, {
      topK: this.topK,
      pathway: ctx.pathway,
    });

    const topScore = results[0]?.score ?? 0;
    return { results, query, grounded: topScore >= this.minScore, topScore };
  }

  /**
   * Validate citations returned by the LLM against what was actually retrieved.
   *
   * A citation naming a chunk that does not exist, or one that was never shown to the
   * model, is a fabrication. The caller retries once and then fails over to the static
   * fallback rather than sending unsupported clinical advice to a mother.
   */
  validateCitations(
    citations: ReadonlyArray<{ chunk_id: string }>,
    shown: readonly SearchResult[],
  ): { valid: boolean; unknown: string[] } {
    const allowed = new Set(shown.map((r) => r.chunk.chunkId));
    const unknown = citations.map((c) => c.chunk_id).filter((id) => !allowed.has(id));
    return { valid: unknown.length === 0, unknown };
  }
}

/**
 * Render retrieved chunks as numbered context blocks for the prompt.
 *
 * Each block carries its chunk ID so the model can cite it, and its publisher and section
 * so a clinical reviewer can trace a claim back to the source document.
 */
export function renderContext(results: readonly SearchResult[]): string {
  if (results.length === 0) {
    return 'NO CLINICAL GUIDANCE RETRIEVED. You are not grounded: do not make specific clinical claims, and prefer a more cautious urgency level.';
  }

  return results
    .map((r, i) => {
      const c: Chunk = r.chunk;
      const where = [c.publisher, c.section].filter(Boolean).join(' — ');
      const page = c.pageFrom ? ` (p.${c.pageFrom}${c.pageTo && c.pageTo !== c.pageFrom ? `-${c.pageTo}` : ''})` : '';
      return `[${i + 1}] chunk_id: ${c.chunkId}\nsource: ${where}${page}\n\n${c.text}`;
    })
    .join('\n\n---\n\n');
}
