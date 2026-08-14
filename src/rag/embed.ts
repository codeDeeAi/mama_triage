/**
 * Voyage AI embedding client.
 *
 * Implemented against the REST API with `fetch` rather than an SDK: one less dependency,
 * and the transport is trivially injectable for tests.
 *
 * `input_type` matters and is easy to get wrong. Voyage embeds documents and queries into
 * the same space but expects them tagged differently; embedding a query as a document
 * measurably degrades retrieval. Ingestion uses 'document', retrieval uses 'query'.
 */

export interface EmbedOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Voyage caps batch size; ingestion chunks are sent in batches of this many. */
  batchSize?: number;
  /**
   * Base for exponential backoff between retries, in milliseconds.
   *
   * The default suits query-time embedding, where a slow retry is worse than a failure —
   * a mother is waiting. Ingestion overrides it, because there the opposite is true: a
   * one-off run that takes minutes is fine, and failing means no index at all.
   */
  retryBaseMs?: number;
}

export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class VoyageEmbedder {
  private readonly apiKey: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly batchSize: number;
  private readonly retryBaseMs: number;

  constructor(opts: EmbedOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://api.voyageai.com/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.batchSize = opts.batchSize ?? 64;
    this.retryBaseMs = opts.retryBaseMs ?? 300;
  }

  /** Embed a single search query. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], 'query');
    /* istanbul ignore next -- the API always returns one vector per input */
    if (!vector) throw new EmbeddingError('no embedding returned for query');
    return vector;
  }

  /** Embed corpus chunks, batched. */
  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embed(batch, 'document')));
    }
    return out;
  }

  private async embed(
    input: readonly string[],
    inputType: 'query' | 'document',
  ): Promise<number[][]> {
    if (input.length === 0) return [];

    let lastError: unknown;
    let retryAfterMs: number | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input, model: this.model, input_type: inputType }),
        });

        if (res.ok) {
          const json = (await res.json()) as {
            data?: Array<{ embedding: number[]; index: number }>;
          };
          const data = json.data;
          if (!Array.isArray(data) || data.length !== input.length) {
            throw new EmbeddingError(
              `expected ${input.length} embeddings, received ${data?.length ?? 0}`,
            );
          }
          // The API documents an `index` field; sorting by it rather than trusting
          // response order keeps chunk-to-vector alignment correct.
          return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        }

        const retryable = res.status === 429 || res.status >= 500;
        const detail = await res.text().catch(() => '');
        // Voyage sends Retry-After on a rate limit. Honouring it matters on the free
        // tier, where the limit is per minute: backing off from a few hundred
        // milliseconds exhausts every attempt within seconds and fails a run that would
        // have succeeded by waiting.
        // Optional-chained: a response without headers must not turn a non-retryable
        // status into a thrown TypeError, which the catch below would treat as a
        // transient failure and retry — the opposite of what a 400 or 401 requires.
        const header = Number(res.headers?.get('retry-after'));
        retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : null;
        lastError = new EmbeddingError(
          `Voyage API ${res.status}: ${detail.slice(0, 200)}`,
          res.status,
        );
        if (!retryable) throw lastError;
      } catch (err) {
        if (err instanceof EmbeddingError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        await this.sleep(retryAfterMs ?? 2 ** attempt * this.retryBaseMs);
        retryAfterMs = null;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new EmbeddingError(`embedding failed: ${String(lastError)}`);
  }
}
