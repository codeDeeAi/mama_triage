/**
 * Structure-aware chunking.
 *
 * Fixed-window chunking is wrong for clinical guidelines. The single most important
 * content in WHO IMCI and FMOH BEmONC is danger-sign *lists* and assessment *tables*; a
 * chunk that contains "Check for the following danger signs:" and then stops mid-list is
 * actively dangerous, because the model may retrieve it and conclude the list is complete.
 *
 * So: the document is parsed into blocks (heading, paragraph, list, table), and a list or
 * table is never split across chunks. Chunks are packed up to a token budget, with an
 * overlap of trailing blocks so context is not lost at a boundary. Every chunk carries the
 * heading path it sits under, which is what makes a citation legible to a clinical
 * reviewer checking the system's output against the source PDF.
 */

import type { Pathway } from '../types';
import type { Chunk } from './types';

export interface ChunkOptions {
  /** Target maximum tokens per chunk. */
  maxTokens?: number;
  /** Approximate tokens of trailing context repeated into the next chunk. */
  overlapTokens?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  maxTokens: 600,
  overlapTokens: 80,
};

/**
 * Approximate token count.
 *
 * Roughly 4 characters per token for English clinical prose. This is an estimate, not a
 * tokeniser: it is used only to size chunks, where being 15% out changes nothing. Using a
 * real tokeniser here would add a dependency for no clinical benefit.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

type BlockKind = 'heading' | 'paragraph' | 'list' | 'table';

interface Block {
  kind: BlockKind;
  text: string;
  /** Markdown heading depth, 1-6. Only set for headings. */
  depth?: number;
  tokens: number;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const PAGE_MARKER = /^\s*\[\[page:(\d+)\]\]\s*$/i;

/**
 * Split raw document text into structural blocks.
 *
 * Consecutive list items form one block; consecutive table rows form one block. Page
 * markers of the form `[[page:12]]` (emitted by the PDF extraction step) are consumed and
 * tracked rather than becoming content.
 */
export function toBlocks(text: string): Array<Block & { page?: number }> {
  const lines = text.split(/\r?\n/);
  const blocks: Array<Block & { page?: number }> = [];

  let buffer: string[] = [];
  let kind: BlockKind = 'paragraph';
  let page: number | undefined;

  const flush = (): void => {
    const joined = buffer.join('\n').trim();
    buffer = [];
    if (joined.length === 0) return;
    blocks.push({ kind, text: joined, tokens: estimateTokens(joined), page });
  };

  for (const line of lines) {
    const pageMatch = PAGE_MARKER.exec(line);
    if (pageMatch) {
      flush();
      page = Number(pageMatch[1]);
      continue;
    }

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      flush();
      const depth = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      blocks.push({
        kind: 'heading',
        text: heading,
        depth,
        tokens: estimateTokens(heading),
        page,
      });
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      kind = 'paragraph';
      continue;
    }

    const lineKind: BlockKind = TABLE_ROW.test(line)
      ? 'table'
      : LIST_ITEM.test(line)
        ? 'list'
        : 'paragraph';

    // A change of block kind ends the current block, so a list is never merged into the
    // paragraph that introduces it — and so is never silently truncated with it.
    if (buffer.length > 0 && lineKind !== kind) {
      flush();
    }
    kind = lineKind;
    buffer.push(line);
  }
  flush();

  return blocks;
}

/** Heading path for a chunk, e.g. "Assess > Young infant > Danger signs". */
function headingPath(stack: Array<{ depth: number; text: string }>): string {
  return stack.map((h) => h.text).join(' > ');
}

/**
 * Infer which pathway a section relates to from its heading path and content.
 *
 * Returns `unset` when a chunk is relevant to both or cannot be determined — retrieval
 * treats `unset` as applicable to either pathway, so an ambiguous chunk stays available
 * rather than being wrongly excluded from one side.
 */
export function inferPathway(text: string): Pathway {
  const t = text.toLowerCase();

  const neonatal =
    /\b(?:newborn|neonat|young infant|baby|infant|birth weight|breastfeed|cord|fontanelle|jaundice)\b/.test(
      t,
    );
  // "breast" alone is deliberately NOT a maternal marker: breastfeeding and attachment
  // are discussed constantly in neonatal guidance, so it would make most newborn feeding
  // content read as ambiguous. Maternal breast pathology has its own vocabulary.
  const maternal =
    /\b(?:mother|maternal|postpartum|postnatal|puerper|lochia|uterus|uterine|eclampsia|haemorrhage|hemorrhage|perineal|caesarean|episiotomy|mastitis|breast abscess|engorge|cracked nipple)\b/.test(
      t,
    );

  if (neonatal && !maternal) return 'neonatal';
  if (maternal && !neonatal) return 'maternal';
  return 'unset';
}

const TOPIC_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['fever', /\bfever|temperature|hypothermi/i],
  ['sepsis', /\bsepsis|infection|septic/i],
  ['bleeding', /\bbleed|haemorrhag|hemorrhag|lochia/i],
  ['eclampsia', /\beclampsia|convuls|seizure|blood pressure|hypertens/i],
  ['jaundice', /\bjaundice|yellow/i],
  ['breathing', /\bbreath|respirat|apn|chest indrawing/i],
  ['feeding', /\bfeed|suck|breastfeed|milk/i],
  ['danger_signs', /\bdanger sign|general danger/i],
  ['referral', /\brefer|urgent|emergency|hospital/i],
];

export function inferTopics(text: string): string[] {
  return TOPIC_PATTERNS.filter(([, re]) => re.test(text)).map(([topic]) => topic);
}

export interface ChunkDocumentInput {
  text: string;
  documentSlug: string;
  title: string;
  publisher: string;
  docVersion?: string;
}

/**
 * Chunk a document.
 *
 * Guarantees:
 *   - a list or table block is never split across chunks;
 *   - every chunk records the heading path it sits under;
 *   - consecutive chunks overlap by roughly `overlapTokens` of trailing blocks.
 */
export function chunkDocument(input: ChunkDocumentInput, opts: ChunkOptions = {}): Chunk[] {
  const { maxTokens, overlapTokens } = { ...DEFAULTS, ...opts };
  const blocks = toBlocks(input.text);

  const chunks: Chunk[] = [];
  const headingStack: Array<{ depth: number; text: string }> = [];

  let current: Array<Block & { page?: number }> = [];
  let currentTokens = 0;
  let sectionAtChunkStart = '';
  let ordinal = 0;

  /**
   * @param carryOverlap Repeat trailing blocks into the next chunk. False at a section
   *   boundary: overlap exists to preserve context within a flowing section, and carrying
   *   text across a heading would both mislabel the next chunk and pollute the new section
   *   with the previous one's content.
   */
  const emit = (carryOverlap = true): void => {
    const body = current
      .filter((b) => b.kind !== 'heading')
      .map((b) => b.text)
      .join('\n\n')
      .trim();

    if (body.length === 0) {
      current = [];
      currentTokens = 0;
      return;
    }

    const section = sectionAtChunkStart || headingPath(headingStack);
    // The heading path is prepended to the embedded text: a chunk reading "Not able to
    // feed" means nothing to an embedding model without "Young infant > Danger signs"
    // above it.
    const text = section ? `${section}\n\n${body}` : body;

    const pages = current.map((b) => b.page).filter((p): p is number => p !== undefined);

    ordinal += 1;
    chunks.push({
      chunkId: `${input.documentSlug}#${ordinal}`,
      documentSlug: input.documentSlug,
      title: input.title,
      publisher: input.publisher,
      ...(input.docVersion ? { docVersion: input.docVersion } : {}),
      section,
      ...(pages.length > 0 ? { pageFrom: Math.min(...pages), pageTo: Math.max(...pages) } : {}),
      pathway: inferPathway(`${section}\n${body}`),
      topics: inferTopics(`${section}\n${body}`),
      tokenCount: estimateTokens(text),
      text,
    });

    // Carry trailing blocks forward as overlap, but never carry a heading-only tail.
    const carried: Array<Block & { page?: number }> = [];
    let carriedTokens = 0;
    if (carryOverlap) {
      for (let i = current.length - 1; i >= 0; i--) {
        const block = current[i]!;
        if (block.kind === 'heading') continue;
        if (carriedTokens + block.tokens > overlapTokens) break;
        carried.unshift(block);
        carriedTokens += block.tokens;
      }
    }

    current = carried;
    currentTokens = carriedTokens;
    sectionAtChunkStart = headingPath(headingStack);
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // A new section at the same or shallower depth ends the current chunk, so a chunk
      // never straddles two unrelated sections.
      const depth = block.depth ?? 1;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.depth >= depth) {
        headingStack.pop();
      }
      // Always emit at a section boundary when there is content, even if the chunk is
      // small. Holding a short section open would attribute the NEXT section's content to
      // this section's heading — a mis-citation that sends a reviewer tracing the claim to
      // the wrong page. A small correctly-labelled chunk is strictly better.
      if (currentTokens > 0) emit(false);
      headingStack.push({ depth, text: block.text });
      // `current` is empty after a no-overlap emit, so the next chunk starts cleanly
      // under the new heading path.
      sectionAtChunkStart = headingPath(headingStack);
      continue;
    }

    // An indivisible block that alone exceeds the budget still becomes its own chunk
    // rather than being split. Truncating a danger-sign list is worse than a large chunk.
    if (block.tokens > maxTokens) {
      if (currentTokens > 0) emit();
      current = [block];
      currentTokens = block.tokens;
      emit();
      continue;
    }

    if (currentTokens + block.tokens > maxTokens && currentTokens > 0) {
      emit();
    }

    current.push(block);
    currentTokens += block.tokens;
  }

  if (currentTokens > 0) emit();

  return chunks;
}
