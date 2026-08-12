/**
 * In-process vector store.
 *
 * Brute-force cosine similarity over a prebuilt index loaded into memory. For a corpus of
 * a few thousand guideline chunks this takes well under a millisecond per query, and it
 * removes a stateful service from the deployment entirely: the index is a file built at
 * Docker build time and shipped read-only inside the image, pinned to the image digest.
 *
 * That last property matters for the research: an evaluation run is reproducible only if
 * the exact knowledge base it used is pinned, and "the index baked into image sha256:…"
 * is a far stronger guarantee than "whatever was in the vector database that afternoon".
 *
 * If the corpus ever grows past the point where a linear scan is acceptable, `VectorStore`
 * is the seam to swap in pgvector (the Cloud SQL instance already exists) or a Chroma
 * server, without touching retrieval or the orchestrator.
 */

import { readFileSync } from 'node:fs';
import type {
  Chunk,
  EmbeddedChunk,
  IndexFile,
  SearchOptions,
  SearchResult,
  VectorStore,
} from './types';
import { INDEX_VERSION } from './types';

/**
 * Cosine similarity between two vectors.
 *
 * Embeddings from Voyage are already L2-normalised, so a dot product would suffice — but
 * normalising here costs microseconds and makes the function correct for any input,
 * including hand-written test vectors.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class MemoryVectorStore implements VectorStore {
  private readonly chunks: EmbeddedChunk[];
  private readonly byId: Map<string, EmbeddedChunk>;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly builtAt: string;

  constructor(index: IndexFile) {
    if (index.version !== INDEX_VERSION) {
      throw new Error(
        `unsupported index version ${index.version}; expected ${INDEX_VERSION}. ` +
          `Rebuild with: npm run kb:ingest`,
      );
    }
    this.chunks = index.chunks;
    this.embeddingModel = index.embeddingModel;
    this.dimensions = index.dimensions;
    this.builtAt = index.builtAt;
    this.byId = new Map(index.chunks.map((c) => [c.chunkId, c]));
  }

  static fromFile(path: string): MemoryVectorStore {
    const raw = readFileSync(path, 'utf8');
    return new MemoryVectorStore(JSON.parse(raw) as IndexFile);
  }

  async search(
    queryEmbedding: readonly number[],
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const topK = opts.topK ?? 5;
    const pathway = opts.pathway ?? 'unset';

    if (queryEmbedding.length !== this.dimensions && this.chunks.length > 0) {
      throw new Error(
        `query embedding has ${queryEmbedding.length} dimensions, index has ${this.dimensions}. ` +
          `The query and the index must come from the same embedding model.`,
      );
    }

    const scored: SearchResult[] = [];

    for (const chunk of this.chunks) {
      // A chunk tagged `unset` applies to both pathways; a pathway-tagged chunk is only
      // eligible for its own pathway. This is what stops neonatal jaundice guidance being
      // retrieved into a maternal haemorrhage assessment.
      if (pathway !== 'unset' && chunk.pathway !== 'unset' && chunk.pathway !== pathway) {
        continue;
      }
      scored.push({
        chunk: stripEmbedding(chunk),
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  size(): number {
    return this.chunks.length;
  }

  get(chunkId: string): Chunk | undefined {
    const found = this.byId.get(chunkId);
    return found ? stripEmbedding(found) : undefined;
  }

  /** IDs of every indexed chunk. Used to validate a set of citations in one pass. */
  ids(): string[] {
    return [...this.byId.keys()];
  }
}

function stripEmbedding(c: EmbeddedChunk): Chunk {
  const { embedding: _embedding, ...rest } = c;
  return rest;
}

/** Build an index file from embedded chunks. */
export function buildIndex(
  chunks: EmbeddedChunk[],
  embeddingModel: string,
  sources: IndexFile['sources'],
): IndexFile {
  const dimensions = chunks[0]?.embedding.length ?? 0;

  for (const c of chunks) {
    if (c.embedding.length !== dimensions) {
      throw new Error(
        `chunk ${c.chunkId} has ${c.embedding.length} dimensions, expected ${dimensions}`,
      );
    }
  }

  return {
    version: INDEX_VERSION,
    embeddingModel,
    dimensions,
    builtAt: new Date().toISOString(),
    sources,
    chunks,
  };
}
