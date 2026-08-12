/**
 * Corpus ingestion.
 *
 * Reads the source corpus, chunks it, embeds it, writes the index file, and records
 * provenance in `clinical_documents` / `document_chunks`.
 *
 * Run with: npm run kb:ingest
 *
 * Provenance is not bookkeeping. An evaluation result is only reproducible if the exact
 * knowledge base that produced it is identified, so every document is hashed and every
 * chunk is traceable to a document version and section. If a source file changes, its
 * SHA-256 changes, and the index must be rebuilt before the next evaluation run.
 *
 * PDF extraction is deliberately NOT part of this step. Extraction quality varies enough
 * between documents that it needs human checking; the expected input here is Markdown
 * produced by a separate, reviewable extraction pass, with `[[page:N]]` markers preserved.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { chunkDocument } from './chunk';
import { VoyageEmbedder } from './embed';
import { buildIndex } from './store';
import type { Chunk, EmbeddedChunk, IndexFile } from './types';
// Imported statically for the CLI entrypoint below. `getConfig()` is lazy, so importing
// these modules validates nothing and has no side effect beyond loading dotenv.
import { getConfig } from '../config';
import { createDb } from '../db/pool';

export interface SourceDocument {
  slug: string;
  title: string;
  publisher: string;
  docVersion?: string;
  sourceUri?: string;
  retrievedAt?: string;
  text: string;
  sha256: string;
}

/** Front matter at the top of each corpus file. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function parseFrontMatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(match[0].length) };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Load every `.md` file in a directory as a source document. */
export function loadCorpus(dir: string): SourceDocument[] {
  const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() === '.md');
  const docs: SourceDocument[] = [];

  for (const file of files.sort()) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const slug = meta.slug ?? basename(file, extname(file));

    if (!meta.title || !meta.publisher) {
      throw new Error(
        `${file}: front matter must set at least 'title' and 'publisher'. ` +
          `Provenance is required — a chunk that cannot be traced to a source document ` +
          `cannot be cited in the report.`,
      );
    }

    docs.push({
      slug,
      title: meta.title,
      publisher: meta.publisher,
      ...(meta.version ? { docVersion: meta.version } : {}),
      ...(meta.source_uri ? { sourceUri: meta.source_uri } : {}),
      ...(meta.retrieved_at ? { retrievedAt: meta.retrieved_at } : {}),
      text: body,
      // Hash the raw file including front matter: a version bump is a corpus change.
      sha256: sha256(raw),
    });
  }

  return docs;
}

export function chunkCorpus(docs: readonly SourceDocument[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of docs) {
    chunks.push(
      ...chunkDocument({
        text: doc.text,
        documentSlug: doc.slug,
        title: doc.title,
        publisher: doc.publisher,
        ...(doc.docVersion ? { docVersion: doc.docVersion } : {}),
      }),
    );
  }
  return chunks;
}

export interface IngestOptions {
  corpusDir: string;
  outputPath: string;
  embedder: Pick<VoyageEmbedder, 'embedDocuments' | 'model'>;
  /** Optional: record provenance in Postgres as well as the index file. */
  db?: {
    query(text: string, params?: readonly unknown[]): Promise<unknown[]>;
  };
  log?: (msg: string) => void;
}

export interface IngestResult {
  documents: number;
  chunks: number;
  dimensions: number;
  outputPath: string;
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const log = opts.log ?? (() => undefined);

  const docs = loadCorpus(opts.corpusDir);
  if (docs.length === 0) {
    throw new Error(
      `no .md documents found in ${opts.corpusDir}. ` +
        `Place extracted guideline text there before running ingestion.`,
    );
  }
  log(`loaded ${docs.length} document(s)`);

  const chunks = chunkCorpus(docs);
  log(`produced ${chunks.length} chunk(s)`);

  const embeddings = await opts.embedder.embedDocuments(chunks.map((c) => c.text));
  const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({
    ...c,
    embedding: embeddings[i]!,
  }));

  const index: IndexFile = buildIndex(
    embedded,
    opts.embedder.model,
    docs.map((d) => ({
      slug: d.slug,
      sha256: d.sha256,
      title: d.title,
      publisher: d.publisher,
    })),
  );

  mkdirSync(dirnameOf(opts.outputPath), { recursive: true });
  writeFileSync(opts.outputPath, JSON.stringify(index), 'utf8');
  log(`wrote ${opts.outputPath} (${index.dimensions} dimensions)`);

  if (opts.db) await recordProvenance(opts.db, docs, embedded, opts.embedder.model);

  return {
    documents: docs.length,
    chunks: embedded.length,
    dimensions: index.dimensions,
    outputPath: opts.outputPath,
  };
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '.' : path.slice(0, idx);
}

async function recordProvenance(
  db: NonNullable<IngestOptions['db']>,
  docs: readonly SourceDocument[],
  chunks: readonly EmbeddedChunk[],
  embeddingModel: string,
): Promise<void> {
  for (const doc of docs) {
    const docChunks = chunks.filter((c) => c.documentSlug === doc.slug);

    const rows = (await db.query(
      `INSERT INTO clinical_documents
         (title, publisher, doc_version, source_uri, retrieved_at, sha256,
          chunk_count, embedding_model, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (sha256) DO UPDATE
         SET chunk_count = EXCLUDED.chunk_count,
             embedding_model = EXCLUDED.embedding_model,
             indexed_at = NOW()
       RETURNING id`,
      [
        doc.title,
        doc.publisher,
        doc.docVersion ?? null,
        doc.sourceUri ?? null,
        doc.retrievedAt ?? null,
        doc.sha256,
        docChunks.length,
        embeddingModel,
      ],
    )) as Array<{ id: string }>;

    const documentId = rows[0]?.id;
    if (!documentId) continue;

    await db.query(`DELETE FROM document_chunks WHERE document_id = $1`, [documentId]);

    for (const c of docChunks) {
      await db.query(
        `INSERT INTO document_chunks
           (document_id, chroma_id, section, page_from, page_to, pathway_tag, token_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (chroma_id) DO NOTHING`,
        [
          documentId,
          c.chunkId,
          c.section,
          c.pageFrom ?? null,
          c.pageTo ?? null,
          c.pathway,
          c.tokenCount,
        ],
      );
    }
  }
}

/* istanbul ignore next -- CLI wiring, exercised by running the script */
async function main(): Promise<void> {
  const config = getConfig();

  const db = createDb(config.databaseUrl);
  try {
    const result = await ingest({
      corpusDir: process.env.CORPUS_DIR ?? 'knowledge/sources',
      outputPath: config.rag.chromaPath.endsWith('.json')
        ? config.rag.chromaPath
        : `${config.rag.chromaPath}/index.json`,
      embedder: new VoyageEmbedder({
        apiKey: config.rag.voyageApiKey,
        model: config.rag.embeddingModel,
      }),
      db,
      log: (m) => process.stdout.write(`${m}\n`),
    });
    process.stdout.write(
      `\nIngestion complete: ${result.documents} document(s), ${result.chunks} chunk(s).\n`,
    );
  } finally {
    await db.close();
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`Ingestion failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
