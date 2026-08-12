import { buildQuery, renderContext, Retriever } from '../../../src/rag/retrieve';
import { buildIndex, MemoryVectorStore } from '../../../src/rag/store';
import type { EmbeddedChunk, SearchResult } from '../../../src/rag/types';
import type { Pathway } from '../../../src/types';

describe('buildQuery — clinical state, not raw words', () => {
  it('renders neonatal slots as clinical English', () => {
    const q = buildQuery({
      pathway: 'neonatal',
      slots: { feeding: 'unable_to_feed', temperature: 'cold_to_touch', age_days: 6 },
      message: 'e no dey chop, body dey cold',
    });

    expect(q).toContain('not able to feed');
    expect(q).toContain('low body temperature');
    expect(q).toContain('infant aged 6 days');
    // The whole point: the Pidgin surface form is NOT what gets embedded once clinical
    // state exists, because the corpus is written in clinical English.
    expect(q).not.toContain('no dey chop');
  });

  it('renders maternal slots as clinical English', () => {
    const q = buildQuery({
      pathway: 'maternal',
      slots: { bleeding: 'soaking_pad_hourly', days_postpartum: 3, delivery_mode: 'caesarean' },
      message: 'blood dey rush',
    });

    expect(q).toContain('postpartum haemorrhage');
    expect(q).toContain('3 days postpartum');
    expect(q).toContain('caesarean delivery');
  });

  it('falls back to the raw message when no slots are filled yet', () => {
    const q = buildQuery({
      pathway: 'unset',
      slots: {},
      message: 'my baby is not feeding well since morning',
    });
    expect(q).toContain('my baby is not feeding well');
  });

  it('does not fall back once any clinical state exists', () => {
    const q = buildQuery({
      pathway: 'neonatal',
      slots: { feeding: 'unable_to_feed' },
      message: 'some rambling message text',
    });
    expect(q).not.toContain('rambling');
  });

  it('includes the active assessment domain', () => {
    const q = buildQuery({
      pathway: 'neonatal',
      slots: { feeding: 'reduced' },
      message: '',
      activeDomain: 'jaundice assessment',
    });
    expect(q).toContain('jaundice assessment');
  });

  it('names the pathway so retrieval starts in the right register', () => {
    expect(buildQuery({ pathway: 'neonatal', slots: {}, message: '' })).toContain('young infant');
    expect(buildQuery({ pathway: 'maternal', slots: {}, message: '' })).toContain('postpartum');
  });

  it('truncates a very long message', () => {
    const q = buildQuery({ pathway: 'unset', slots: {}, message: 'x'.repeat(5000) });
    expect(q.length).toBeLessThan(500);
  });

  it('skips slots with no clinical phrasing', () => {
    const q = buildQuery({ pathway: 'maternal', slots: { mood_concerns: 'none' }, message: '' });
    expect(q).not.toContain('undefined');
  });

  it('produces a non-empty query even with nothing to go on', () => {
    expect(buildQuery({ pathway: 'unset', slots: {}, message: '' }).length).toBeGreaterThan(0);
  });
});

function chunk(id: string, embedding: number[], pathway: Pathway = 'unset'): EmbeddedChunk {
  return {
    chunkId: id,
    documentSlug: 'who-imci',
    title: 'IMCI',
    publisher: 'WHO',
    section: 'Danger signs',
    pathway,
    topics: [],
    tokenCount: 10,
    text: `guidance ${id}`,
    embedding,
  };
}

/** Embedder double returning a fixed vector. */
const fixedEmbedder = (vector: number[]) => ({
  embedQuery: async () => vector,
});

describe('Retriever', () => {
  const store = new MemoryVectorStore(
    buildIndex(
      [
        chunk('who-imci#1', [1, 0, 0], 'neonatal'),
        chunk('who-imci#2', [0, 1, 0], 'maternal'),
        chunk('who-imci#3', [0.2, 0.2, 1], 'unset'),
      ],
      'voyage-3',
      [],
    ),
  );

  it('retrieves and reports grounding', async () => {
    const r = new Retriever(store, fixedEmbedder([1, 0, 0]), { minScore: 0.35 });
    const out = await r.retrieve({ pathway: 'neonatal', slots: {}, message: 'baby not feeding' });

    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0]?.chunk.chunkId).toBe('who-imci#1');
    expect(out.grounded).toBe(true);
    expect(out.topScore).toBeCloseTo(1);
  });

  it('reports ungrounded when nothing clears the similarity floor', async () => {
    // An ungrounded model must become MORE cautious, so this flag has to be honest.
    // [1,0,0] is near-orthogonal to every maternal-eligible chunk here, so the best
    // match falls below the default 0.35 floor.
    const r = new Retriever(store, fixedEmbedder([1, 0, 0]));
    const out = await r.retrieve({ pathway: 'maternal', slots: {}, message: 'x' });
    expect(out.topScore).toBeLessThan(0.35);
    expect(out.grounded).toBe(false);
  });

  it('reports ungrounded against an empty index', async () => {
    const empty = new MemoryVectorStore(buildIndex([], 'voyage-3', []));
    const r = new Retriever(empty, fixedEmbedder([1, 0, 0]));
    const out = await r.retrieve({ pathway: 'neonatal', slots: {}, message: 'x' });
    expect(out.results).toEqual([]);
    expect(out.grounded).toBe(false);
    expect(out.topScore).toBe(0);
  });

  it('applies the pathway filter', async () => {
    const r = new Retriever(store, fixedEmbedder([1, 0, 0]));
    const out = await r.retrieve({ pathway: 'maternal', slots: {}, message: 'x' });
    expect(out.results.map((x) => x.chunk.chunkId)).not.toContain('who-imci#1');
  });

  it('returns the query it actually embedded, for the evaluation record', async () => {
    const r = new Retriever(store, fixedEmbedder([1, 0, 0]));
    const out = await r.retrieve({
      pathway: 'neonatal',
      slots: { feeding: 'unable_to_feed' },
      message: 'e no dey chop',
    });
    expect(out.query).toContain('not able to feed');
  });
});

describe('Retriever.validateCitations', () => {
  const store = new MemoryVectorStore(buildIndex([chunk('a#1', [1, 0])], 'voyage-3', []));
  const r = new Retriever(store, fixedEmbedder([1, 0]));

  const shown: SearchResult[] = [
    { chunk: { ...chunk('a#1', [1, 0]), embedding: undefined } as never, score: 1 },
  ];

  it('accepts a citation to a chunk that was shown', () => {
    expect(r.validateCitations([{ chunk_id: 'a#1' }], shown)).toEqual({
      valid: true,
      unknown: [],
    });
  });

  it('rejects a fabricated chunk ID', () => {
    // A model citing a chunk it was never shown has invented the support for its claim.
    const result = r.validateCitations([{ chunk_id: 'who-imci#999' }], shown);
    expect(result.valid).toBe(false);
    expect(result.unknown).toEqual(['who-imci#999']);
  });

  it('rejects a real chunk that was not part of this retrieval', () => {
    expect(r.validateCitations([{ chunk_id: 'b#1' }], shown).valid).toBe(false);
  });

  it('reports every unknown citation', () => {
    const result = r.validateCitations(
      [{ chunk_id: 'a#1' }, { chunk_id: 'x#1' }, { chunk_id: 'y#1' }],
      shown,
    );
    expect(result.unknown).toEqual(['x#1', 'y#1']);
  });

  it('treats an empty citation list as valid at this layer', () => {
    // The schema requires at least one citation; this function only checks that whatever
    // was cited actually exists.
    expect(r.validateCitations([], shown).valid).toBe(true);
  });
});

describe('renderContext', () => {
  const results: SearchResult[] = [
    {
      chunk: {
        chunkId: 'who-imci#7',
        documentSlug: 'who-imci',
        title: 'IMCI Chart Booklet',
        publisher: 'WHO',
        section: 'Assess > Danger signs',
        pageFrom: 12,
        pageTo: 13,
        pathway: 'neonatal',
        topics: ['danger_signs'],
        tokenCount: 20,
        text: 'Not able to feed is a general danger sign.',
      },
      score: 0.8,
    },
  ];

  it('includes the chunk ID so the model can cite it', () => {
    expect(renderContext(results)).toContain('chunk_id: who-imci#7');
  });

  it('includes publisher and section so a reviewer can trace the claim', () => {
    const out = renderContext(results);
    expect(out).toContain('WHO');
    expect(out).toContain('Assess > Danger signs');
    expect(out).toContain('p.12-13');
  });

  it('includes the chunk text', () => {
    expect(renderContext(results)).toContain('Not able to feed is a general danger sign');
  });

  it('renders a single page without a range', () => {
    const single = [{ ...results[0]!, chunk: { ...results[0]!.chunk, pageTo: 12 } }];
    expect(renderContext(single)).toContain('p.12');
    expect(renderContext(single)).not.toContain('p.12-12');
  });

  it('tells the model explicitly when nothing was retrieved', () => {
    const out = renderContext([]);
    expect(out).toMatch(/NO CLINICAL GUIDANCE RETRIEVED/);
    expect(out).toMatch(/more cautious/i);
  });

  it('numbers multiple blocks', () => {
    const two = [results[0]!, { ...results[0]!, chunk: { ...results[0]!.chunk, chunkId: 'who-imci#8' } }];
    const out = renderContext(two);
    expect(out).toContain('[1]');
    expect(out).toContain('[2]');
  });
});
