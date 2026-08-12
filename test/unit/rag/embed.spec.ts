import { EmbeddingError, VoyageEmbedder } from '../../../src/rag/embed';

interface Call {
  url: string;
  body: { input: string[]; model: string; input_type: string };
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Response shaped like the Voyage embeddings API. */
function embeddings(vectors: number[][], shuffled = false) {
  const data = vectors.map((embedding, index) => ({ embedding, index }));
  return { data: shuffled ? [...data].reverse() : data };
}

function embedder(fetchImpl: typeof fetch, opts: { maxRetries?: number; batchSize?: number } = {}) {
  return new VoyageEmbedder({
    apiKey: 'pa-test',
    model: 'voyage-3',
    fetchImpl,
    sleep: async () => undefined,
    ...opts,
  });
}

describe('VoyageEmbedder — request shape', () => {
  it('posts to the embeddings endpoint with a bearer token', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0]]) }]);
    await embedder(f.impl).embedQuery('baby not feeding');
    expect(f.calls[0]?.url).toContain('/embeddings');
    expect(f.calls[0]?.body.model).toBe('voyage-3');
  });

  it('tags a query as input_type "query"', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0]]) }]);
    await embedder(f.impl).embedQuery('x');
    expect(f.calls[0]?.body.input_type).toBe('query');
  });

  it('tags corpus text as input_type "document"', async () => {
    // Voyage embeds queries and documents into the same space but expects them tagged
    // differently; getting this wrong measurably degrades retrieval.
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0]]) }]);
    await embedder(f.impl).embedDocuments(['chunk text']);
    expect(f.calls[0]?.body.input_type).toBe('document');
  });
});

describe('VoyageEmbedder — batching and alignment', () => {
  it('batches large corpora', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings(Array.from({ length: 2 }, () => [1, 0])) }]);
    await embedder(f.impl, { batchSize: 2 }).embedDocuments(['a', 'b', 'c', 'd']);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.body.input).toEqual(['a', 'b']);
    expect(f.calls[1]?.body.input).toEqual(['c', 'd']);
  });

  it('returns one vector per input, in input order', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0], [0, 1]]) }]);
    const out = await embedder(f.impl).embedDocuments(['first', 'second']);
    expect(out).toEqual([[1, 0], [0, 1]]);
  });

  it('realigns by index when the API returns results out of order', async () => {
    // Chunk-to-vector misalignment would silently attach every chunk to the wrong
    // embedding, so ordering is restored from the documented `index` field rather than
    // trusting response order.
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0], [0, 1]], true) }]);
    const out = await embedder(f.impl).embedDocuments(['first', 'second']);
    expect(out).toEqual([[1, 0], [0, 1]]);
  });

  it('rejects a response with the wrong number of embeddings', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings([[1, 0]]) }]);
    await expect(embedder(f.impl).embedDocuments(['a', 'b'])).rejects.toThrow(
      /expected 2 embeddings/,
    );
  });

  it('rejects a malformed response', async () => {
    const f = fakeFetch([{ status: 200, body: { nonsense: true } }]);
    await expect(embedder(f.impl).embedQuery('x')).rejects.toThrow(EmbeddingError);
  });

  it('makes no request for an empty input list', async () => {
    const f = fakeFetch([{ status: 200, body: embeddings([]) }]);
    expect(await embedder(f.impl).embedDocuments([])).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});

describe('VoyageEmbedder — retry policy', () => {
  it('retries a 429', async () => {
    const f = fakeFetch([{ status: 429 }, { status: 200, body: embeddings([[1, 0]]) }]);
    expect(await embedder(f.impl).embedQuery('x')).toEqual([1, 0]);
    expect(f.calls).toHaveLength(2);
  });

  it('retries a 500', async () => {
    const f = fakeFetch([{ status: 500 }, { status: 200, body: embeddings([[1, 0]]) }]);
    await embedder(f.impl).embedQuery('x');
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry a 401 — a bad key will still be bad', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'invalid api key' } }]);
    await expect(embedder(f.impl).embedQuery('x')).rejects.toThrow(/401/);
    expect(f.calls).toHaveLength(1);
  });

  it('does not retry a 400', async () => {
    const f = fakeFetch([{ status: 400 }]);
    await expect(embedder(f.impl).embedQuery('x')).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const f = fakeFetch([{ status: 503 }]);
    await expect(embedder(f.impl, { maxRetries: 2 }).embedQuery('x')).rejects.toThrow();
    expect(f.calls).toHaveLength(3);
  });

  it('retries a network failure', async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, json: async () => embeddings([[1, 0]]), text: async () => '' };
    }) as unknown as typeof fetch;

    expect(await embedder(impl).embedQuery('x')).toEqual([1, 0]);
    expect(n).toBe(2);
  });
});
