/**
 * RAG pipeline types.
 *
 * The `VectorStore` interface is the seam that keeps the storage decision reversible.
 *
 * NOTE ON CHROMADB (correction to IMPLEMENTATION_PLAN.md section 10.4): the `chromadb`
 * npm package is an HTTP client for a running Chroma server. Embedded/persistent mode is
 * Python-only, so the plan's "build the index at Docker build time and load it in-process"
 * is not achievable on Node. `MemoryVectorStore` implements that intent directly instead:
 * a prebuilt index file is shipped in the image and searched in-process by brute-force
 * cosine similarity. For a static corpus of a few thousand chunks this is sub-millisecond
 * and removes an entire stateful service from the deployment.
 */

import type { Pathway } from '../types';

/** Metadata carried alongside every chunk. Mirrors `document_chunks` in migration 004. */
export interface ChunkMetadata {
  /** Stable ID: `${documentSlug}#${ordinal}`. The citation key returned to the LLM. */
  chunkId: string;
  documentSlug: string;
  title: string;
  publisher: string;
  docVersion?: string;
  /** Heading path, e.g. "Chapter 2 > Assess the young infant > Danger signs". */
  section: string;
  pageFrom?: number;
  pageTo?: number;
  /** `unset` means the chunk applies to both pathways. */
  pathway: Pathway;
  /** Free tags used for diagnostics, not for filtering. */
  topics: string[];
  tokenCount: number;
}

export interface Chunk extends ChunkMetadata {
  text: string;
}

/** A chunk plus its embedding, as written to the index file. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface SearchResult {
  chunk: Chunk;
  /** Cosine similarity in [-1, 1]. Higher is more similar. */
  score: number;
}

export interface SearchOptions {
  topK?: number;
  /** Restrict to chunks tagged for this pathway (plus `unset`, which applies to both). */
  pathway?: Pathway;
  /**
   * Minimum cosine similarity for a result to count as grounding. Results below this are
   * still returned but `RetrievalOutcome.grounded` is false, which the prompt uses to tell
   * the model it is unsupported and must be more cautious, not less.
   */
  minScore?: number;
}

export interface VectorStore {
  search(queryEmbedding: readonly number[], opts?: SearchOptions): Promise<SearchResult[]>;
  /** Number of indexed chunks. Used by the readiness check. */
  size(): number;
  /** Look up a chunk by ID — used to validate citations returned by the LLM. */
  get(chunkId: string): Chunk | undefined;
}

/** On-disk index format. Versioned so a stale index is detected rather than misread. */
export interface IndexFile {
  version: 1;
  embeddingModel: string;
  dimensions: number;
  builtAt: string;
  /** SHA-256 of every source document, so a corpus change forces a rebuild. */
  sources: Array<{ slug: string; sha256: string; title: string; publisher: string }>;
  chunks: EmbeddedChunk[];
}

export const INDEX_VERSION = 1 as const;
