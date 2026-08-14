/**
 * Build the knowledge index if it is missing or out of date, and do nothing if it is not.
 *
 * Runs automatically before `npm start` (as `prestart`) and from the container
 * entrypoint, so a deployment cannot start with no index simply because nobody
 * remembered to run ingestion. Without this the service starts perfectly healthy and
 * answers every mother from the deterministic red-flag paths alone, which looks like a
 * working system rather than a broken one.
 *
 * Idempotent by design. It re-embeds only when the corpus files or the embedding model
 * actually change, compared by SHA-256 of each source file, so restarting a service does
 * not re-embed and does not re-bill.
 *
 * Behaviour when there is no key and no usable index:
 *
 *   BUILD_INDEX_ON_BOOT=true   refuse to start — the operator said this deployment must
 *                              be able to assess
 *   unset (default)            warn and continue — the safety layer still runs, and
 *                              taking it offline would remove working red-flag detection
 *   BUILD_INDEX_ON_BOOT=false  skip entirely
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getConfig } from '../config';
import { createDb } from '../db/pool';
import { VoyageEmbedder } from './embed';
import { ingest, sha256 } from './ingest';

export interface IndexFileShape {
  embeddingModel?: string;
  sources?: Array<{ sha256?: string }>;
}

/**
 * Is the index on disk usable for this corpus and model?
 *
 * A placeholder index fails this check without needing to be special-cased: it records
 * `offline-hash-v1` as its model and the hash of a placeholder document, so neither the
 * model nor the source hashes match a real deployment.
 */
export function indexIsCurrent(
  indexPath: string,
  corpusDir: string,
  embeddingModel: string,
): boolean {
  if (!existsSync(indexPath)) return false;

  let index: IndexFileShape;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as IndexFileShape;
  } catch {
    // A truncated or corrupt index is not current. Rebuilding is the right response;
    // failing here would leave a deployment stuck on a bad file.
    return false;
  }

  if (index.embeddingModel !== embeddingModel) return false;

  const known = new Set((index.sources ?? []).map((s) => s.sha256));
  const files = readdirSync(corpusDir).filter((f) => extname(f).toLowerCase() === '.md');
  if (files.length === 0) return false;

  return files.every((f) => known.has(sha256(readFileSync(join(corpusDir, f), 'utf8'))));
}

/** Resolve the configured index path, which may name the file or its directory. */
export function resolveIndexPath(chromaPath: string): string {
  return chromaPath.endsWith('.json') ? chromaPath : join(chromaPath, 'index.json');
}

/* istanbul ignore next -- CLI wiring, exercised by running the script */
async function main(): Promise<void> {
  const mode = process.env.BUILD_INDEX_ON_BOOT;
  if (mode === 'false') {
    process.stdout.write('Knowledge index: skipped (BUILD_INDEX_ON_BOOT=false).\n');
    return;
  }

  const config = getConfig();
  const corpusDir = process.env.CORPUS_DIR ?? 'knowledge/sources';
  const chromaPath = config.rag?.chromaPath ?? process.env.CHROMA_PATH ?? './knowledge/index';
  const embeddingModel = config.rag?.embeddingModel ?? process.env.EMBEDDING_MODEL ?? 'voyage-4-lite';
  const indexPath = resolveIndexPath(chromaPath);

  if (indexIsCurrent(indexPath, corpusDir, embeddingModel)) {
    process.stdout.write(`Knowledge index: current (${indexPath}).\n`);
    return;
  }

  if (!config.rag) {
    const message =
      'Knowledge index is missing or out of date, and VOYAGE_API_KEY is not set.';
    if (mode === 'true') {
      process.stderr.write(
        `FATAL: ${message}\n\n` +
          'BUILD_INDEX_ON_BOOT=true means this deployment must be able to assess.\n' +
          'Set VOYAGE_API_KEY, or BUILD_INDEX_ON_BOOT=false to run without assessment.\n',
      );
      process.exit(1);
    }
    process.stderr.write(
      `WARNING: ${message}\n` +
        '         Assessment will be disabled. Consent and the deterministic safety\n' +
        '         layer still run. /readyz reports the reason.\n',
    );
    return;
  }

  process.stdout.write('Knowledge index: building (missing, stale, or a placeholder)...\n');
  const db = createDb(config.databaseUrl);
  try {
    const result = await ingest({
      corpusDir,
      outputPath: indexPath,
      // Tuned for the free tier, which without a payment method is 3 requests and
      // 10,000 tokens per minute. The query-time defaults (64 per batch, sub-second
      // backoff) exceed both on the first request and then give up within seconds.
      //
      // Small batches keep each request under the token limit, and a patient backoff
      // lets a per-minute window actually reset. Ingestion runs once and can afford
      // minutes; failing means no index at all.
      embedder: new VoyageEmbedder({
        apiKey: config.rag.voyageApiKey,
        model: config.rag.embeddingModel,
        batchSize: Number(process.env.EMBED_BATCH_SIZE ?? 16),
        maxRetries: Number(process.env.EMBED_MAX_RETRIES ?? 8),
        retryBaseMs: Number(process.env.EMBED_RETRY_BASE_MS ?? 5000),
      }),
      db,
      log: (m) => process.stdout.write(`  ${m}\n`),
    });
    process.stdout.write(
      `Knowledge index: built — ${result.documents} document(s), ${result.chunks} chunk(s).\n`,
    );
  } finally {
    await db.close();
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
