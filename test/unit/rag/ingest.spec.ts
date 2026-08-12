import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkCorpus,
  ingest,
  loadCorpus,
  parseFrontMatter,
  sha256,
} from '../../../src/rag/ingest';
import { MemoryVectorStore } from '../../../src/rag/store';
import type { IndexFile } from '../../../src/rag/types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-corpus-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeDoc(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

const VALID = `---
slug: who-imci
title: IMCI Chart Booklet
publisher: WHO
version: "2014"
retrieved_at: 2026-08-12
---

# Assess

## Danger signs

[[page:12]]
Check for the following:

- Not able to feed
- Convulsions
- Lethargy
`;

describe('parseFrontMatter', () => {
  it('extracts key/value pairs and returns the body', () => {
    const { meta, body } = parseFrontMatter(VALID);
    expect(meta.slug).toBe('who-imci');
    expect(meta.title).toBe('IMCI Chart Booklet');
    expect(meta.version).toBe('2014'); // quotes stripped
    expect(body).toContain('# Assess');
    expect(body).not.toContain('---');
  });

  it('returns the whole text when there is no front matter', () => {
    const { meta, body } = parseFrontMatter('# Just a heading');
    expect(meta).toEqual({});
    expect(body).toBe('# Just a heading');
  });

  it('ignores malformed lines', () => {
    const { meta } = parseFrontMatter('---\ntitle: X\nnonsense\n---\nbody');
    expect(meta.title).toBe('X');
    expect(Object.keys(meta)).toEqual(['title']);
  });
});

describe('sha256', () => {
  it('produces a stable 64-character digest', () => {
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('abc')).toBe(sha256('abc'));
  });

  it('changes when the content changes', () => {
    // This is the signal that the index must be rebuilt.
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
});

describe('loadCorpus', () => {
  it('loads a document with provenance', () => {
    writeDoc('imci.md', VALID);
    const [doc] = loadCorpus(dir);

    expect(doc).toMatchObject({
      slug: 'who-imci',
      title: 'IMCI Chart Booklet',
      publisher: 'WHO',
      docVersion: '2014',
      retrievedAt: '2026-08-12',
    });
    expect(doc!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a document with no title or publisher', () => {
    // A chunk that cannot be traced to a source cannot be cited in the report.
    writeDoc('bad.md', '---\nslug: x\n---\n\n# Content');
    expect(() => loadCorpus(dir)).toThrow(/must set at least 'title' and 'publisher'/);
  });

  it('explains why provenance is required', () => {
    writeDoc('bad.md', '---\ntitle: X\n---\n\n# Content');
    expect(() => loadCorpus(dir)).toThrow(/cannot be cited in the report/);
  });

  it('falls back to the filename for a missing slug', () => {
    writeDoc('fallback.md', '---\ntitle: T\npublisher: P\n---\n\n# X\n\nSome body text.');
    expect(loadCorpus(dir)[0]?.slug).toBe('fallback');
  });

  it('ignores non-Markdown files', () => {
    writeDoc('imci.md', VALID);
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    writeFileSync(join(dir, 'source.pdf'), 'binary');
    expect(loadCorpus(dir)).toHaveLength(1);
  });

  it('loads documents in a stable order', () => {
    writeDoc('b.md', '---\ntitle: B\npublisher: P\n---\n\n# B\n\nBody b.');
    writeDoc('a.md', '---\ntitle: A\npublisher: P\n---\n\n# A\n\nBody a.');
    expect(loadCorpus(dir).map((d) => d.slug)).toEqual(['a', 'b']);
  });

  it('returns an empty list for an empty directory', () => {
    expect(loadCorpus(dir)).toEqual([]);
  });
});

describe('chunkCorpus', () => {
  it('chunks every document, keeping IDs namespaced per document', () => {
    writeDoc('imci.md', VALID);
    writeDoc(
      'bemonc.md',
      '---\nslug: fmoh-bemonc\ntitle: BEmONC\npublisher: FMOH Nigeria\n---\n\n# Postpartum haemorrhage\n\nAssess bleeding after delivery carefully.',
    );

    const chunks = chunkCorpus(loadCorpus(dir));
    const slugs = new Set(chunks.map((c) => c.documentSlug));
    expect(slugs).toEqual(new Set(['who-imci', 'fmoh-bemonc']));
    expect(chunks.every((c) => c.chunkId.includes('#'))).toBe(true);
    expect(new Set(chunks.map((c) => c.chunkId)).size).toBe(chunks.length);
  });
});

/** Deterministic embedder: hashes text to a small vector. No network. */
const fakeEmbedder = {
  model: 'fake-embed-v1',
  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = [0, 0, 0, 0];
      for (let i = 0; i < t.length; i++) v[i % 4]! += t.charCodeAt(i) % 7;
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

describe('ingest — end to end', () => {
  it('produces a loadable, searchable index', async () => {
    writeDoc('imci.md', VALID);
    const out = join(dir, 'index', 'index.json');

    const result = await ingest({ corpusDir: dir, outputPath: out, embedder: fakeEmbedder });

    expect(result.documents).toBe(1);
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.dimensions).toBe(4);

    const store = MemoryVectorStore.fromFile(out);
    expect(store.size()).toBe(result.chunks);

    const hits = await store.search([1, 0, 0, 0], { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.publisher).toBe('WHO');
  });

  it('records source hashes in the index for reproducibility', async () => {
    writeDoc('imci.md', VALID);
    const out = join(dir, 'index.json');
    await ingest({ corpusDir: dir, outputPath: out, embedder: fakeEmbedder });

    const index = JSON.parse(readFileSync(out, 'utf8')) as IndexFile;
    expect(index.sources).toHaveLength(1);
    expect(index.sources[0]).toMatchObject({ slug: 'who-imci', publisher: 'WHO' });
    expect(index.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(index.embeddingModel).toBe('fake-embed-v1');
    expect(index.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves the danger-sign list intact through the whole pipeline', async () => {
    writeDoc('imci.md', VALID);
    const out = join(dir, 'index.json');
    await ingest({ corpusDir: dir, outputPath: out, embedder: fakeEmbedder });

    const store = MemoryVectorStore.fromFile(out);
    const all = store.ids().map((id) => store.get(id)!);
    const withList = all.filter((c) => c.text.includes('Not able to feed'));

    expect(withList).toHaveLength(1);
    expect(withList[0]!.text).toContain('Convulsions');
    expect(withList[0]!.text).toContain('Lethargy');
    expect(withList[0]!.section).toContain('Danger signs');
    expect(withList[0]!.pageFrom).toBe(12);
  });

  it('creates the output directory if it does not exist', async () => {
    writeDoc('imci.md', VALID);
    const out = join(dir, 'deep', 'nested', 'index.json');
    await ingest({ corpusDir: dir, outputPath: out, embedder: fakeEmbedder });
    expect(readFileSync(out, 'utf8').length).toBeGreaterThan(0);
  });

  it('refuses to build an index from an empty corpus', async () => {
    mkdirSync(join(dir, 'empty'));
    await expect(
      ingest({ corpusDir: join(dir, 'empty'), outputPath: join(dir, 'i.json'), embedder: fakeEmbedder }),
    ).rejects.toThrow(/no \.md documents found/);
  });

  it('records provenance in the database when one is supplied', async () => {
    writeDoc('imci.md', VALID);
    const statements: string[] = [];
    const db = {
      async query(text: string): Promise<unknown[]> {
        statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        return text.includes('RETURNING id') ? [{ id: '1' }] : [];
      },
    };

    await ingest({ corpusDir: dir, outputPath: join(dir, 'i.json'), embedder: fakeEmbedder, db });

    expect(statements.some((s) => s.startsWith('INSERT INTO clinical_documents'))).toBe(true);
    expect(statements.some((s) => s.startsWith('DELETE FROM document_chunks'))).toBe(true);
    expect(statements.some((s) => s.startsWith('INSERT INTO document_chunks'))).toBe(true);
  });
});

describe('ingest — the committed placeholder corpus', () => {
  it('ingests and is obviously marked as not a clinical source', async () => {
    const out = join(dir, 'index.json');
    const result = await ingest({
      corpusDir: 'knowledge/sources',
      outputPath: out,
      embedder: fakeEmbedder,
    });

    expect(result.documents).toBeGreaterThan(0);

    const store = MemoryVectorStore.fromFile(out);
    // Guard: if a real guideline is ever added, this assertion is the reminder to check
    // that the placeholder has been removed first.
    for (const id of store.ids()) {
      expect(store.get(id)!.publisher).toBe('PLACEHOLDER — NOT A CLINICAL SOURCE');
    }
  });
});
