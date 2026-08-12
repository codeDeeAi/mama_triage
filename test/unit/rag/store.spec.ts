import { buildIndex, cosineSimilarity, MemoryVectorStore } from '../../../src/rag/store';
import type { EmbeddedChunk, IndexFile } from '../../../src/rag/types';
import type { Pathway } from '../../../src/types';

function chunk(
  id: string,
  embedding: number[],
  pathway: Pathway = 'unset',
  text = `text for ${id}`,
): EmbeddedChunk {
  return {
    chunkId: id,
    documentSlug: 'doc',
    title: 'Doc',
    publisher: 'WHO',
    section: 'Section',
    pathway,
    topics: [],
    tokenCount: 10,
    text,
    embedding,
  };
}

function store(chunks: EmbeddedChunk[]): MemoryVectorStore {
  return new MemoryVectorStore(buildIndex(chunks, 'voyage-3', []));
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('ignores magnitude', () => {
    expect(cosineSimilarity([1, 1], [5, 5])).toBeCloseTo(1);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('rejects a dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/);
  });
});

describe('buildIndex', () => {
  it('records the embedding model and dimensions', () => {
    const index = buildIndex([chunk('a#1', [1, 0, 0])], 'voyage-3', []);
    expect(index.embeddingModel).toBe('voyage-3');
    expect(index.dimensions).toBe(3);
    expect(index.version).toBe(1);
  });

  it('rejects inconsistent dimensions rather than shipping a broken index', () => {
    expect(() => buildIndex([chunk('a#1', [1, 0, 0]), chunk('a#2', [1, 0])], 'voyage-3', [])).toThrow(
      /dimensions/,
    );
  });

  it('handles an empty corpus', () => {
    expect(buildIndex([], 'voyage-3', []).dimensions).toBe(0);
  });

  it('carries source provenance', () => {
    const index = buildIndex([chunk('a#1', [1, 0])], 'voyage-3', [
      { slug: 'who-imci', sha256: 'a'.repeat(64), title: 'IMCI', publisher: 'WHO' },
    ]);
    expect(index.sources[0]?.sha256).toHaveLength(64);
  });
});

describe('MemoryVectorStore', () => {
  it('rejects an index built by a different version', () => {
    const bad = { ...buildIndex([], 'voyage-3', []), version: 99 } as unknown as IndexFile;
    expect(() => new MemoryVectorStore(bad)).toThrow(/unsupported index version/);
  });

  it('returns the most similar chunk first', async () => {
    const s = store([
      chunk('a#1', [1, 0, 0]),
      chunk('a#2', [0, 1, 0]),
      chunk('a#3', [0.9, 0.1, 0]),
    ]);
    const results = await s.search([1, 0, 0], { topK: 3 });
    expect(results[0]?.chunk.chunkId).toBe('a#1');
    expect(results[1]?.chunk.chunkId).toBe('a#3');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('respects topK', async () => {
    const s = store([chunk('a#1', [1, 0]), chunk('a#2', [0, 1]), chunk('a#3', [1, 1])]);
    expect(await s.search([1, 0], { topK: 2 })).toHaveLength(2);
  });

  it('defaults to five results', async () => {
    const s = store(Array.from({ length: 10 }, (_, i) => chunk(`a#${i}`, [1, i / 10])));
    expect(await s.search([1, 0])).toHaveLength(5);
  });

  it('never returns the embedding to callers', async () => {
    const s = store([chunk('a#1', [1, 0])]);
    const [first] = await s.search([1, 0]);
    expect(first!.chunk).not.toHaveProperty('embedding');
  });
});

describe('MemoryVectorStore — pathway filtering', () => {
  it('excludes chunks from the other pathway', async () => {
    // The guarantee that stops neonatal jaundice guidance being retrieved into a
    // maternal haemorrhage assessment.
    const s = store([
      chunk('n#1', [1, 0, 0], 'neonatal'),
      chunk('m#1', [1, 0, 0], 'maternal'),
    ]);

    const maternal = await s.search([1, 0, 0], { pathway: 'maternal' });
    expect(maternal.map((r) => r.chunk.chunkId)).toEqual(['m#1']);

    const neonatal = await s.search([1, 0, 0], { pathway: 'neonatal' });
    expect(neonatal.map((r) => r.chunk.chunkId)).toEqual(['n#1']);
  });

  it('always includes unset chunks, which apply to both pathways', async () => {
    const s = store([
      chunk('u#1', [1, 0, 0], 'unset'),
      chunk('n#1', [0.9, 0, 0], 'neonatal'),
    ]);
    const ids = (await s.search([1, 0, 0], { pathway: 'maternal' })).map((r) => r.chunk.chunkId);
    expect(ids).toContain('u#1');
    expect(ids).not.toContain('n#1');
  });

  it('searches everything when no pathway is given', async () => {
    const s = store([chunk('n#1', [1, 0], 'neonatal'), chunk('m#1', [1, 0], 'maternal')]);
    expect(await s.search([1, 0])).toHaveLength(2);
  });
});

describe('MemoryVectorStore — integrity', () => {
  it('rejects a query embedded by a different model', async () => {
    // Mismatched dimensions mean the query and index came from different models, which
    // would silently return meaningless neighbours.
    const s = store([chunk('a#1', [1, 0, 0])]);
    await expect(s.search([1, 0])).rejects.toThrow(/same embedding model/);
  });

  it('tolerates any query against an empty index', async () => {
    const s = store([]);
    expect(await s.search([1, 2, 3])).toEqual([]);
    expect(s.size()).toBe(0);
  });

  it('looks a chunk up by ID for citation validation', () => {
    const s = store([chunk('a#1', [1, 0])]);
    expect(s.get('a#1')?.chunkId).toBe('a#1');
    expect(s.get('a#999')).toBeUndefined();
  });

  it('reports its size and IDs', () => {
    const s = store([chunk('a#1', [1, 0]), chunk('a#2', [0, 1])]);
    expect(s.size()).toBe(2);
    expect(s.ids().sort()).toEqual(['a#1', 'a#2']);
  });
});
