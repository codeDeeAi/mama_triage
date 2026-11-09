import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PCPNC_PAGES,
  PCPNC_SHA256,
  buildPcpncMarkdown,
  cleanPageText,
  fetchPcpnc,
  sha256Hex,
} from '../../../src/rag/fetchPcpnc';
import { chunkCorpus, loadCorpus } from '../../../src/rag/ingest';

/** Stand-in for pdf-parse output: every selected page with recognisable text. */
const PAGES = new Map(PCPNC_PAGES.map((p) => [p.page, `PAGE ${p.page} HEADING\nBody text for page ${p.page}.`]));
const FAKE_PDF = new Uint8Array([1, 2, 3]);

describe('WHO PCPNC build-time extraction', () => {
  it('refuses a PDF whose hash does not match the pinned edition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcpnc-'));
    await expect(fetchPcpnc(dir, async () => FAKE_PDF)).rejects.toThrow(/hash mismatch/);
    expect(sha256Hex(FAKE_PDF)).not.toBe(PCPNC_SHA256);
  });

  it('builds a maternal-domain corpus file with chart headings and page markers', async () => {
    const md = buildPcpncMarkdown(PAGES);
    expect(md).toMatch(/^---\nslug: who-pcpnc-2015\n/);
    expect(md).toContain('domain: maternal');
    expect(md).toContain('[[page:91]]\n\n# D28 Advise on when to return');
    expect(md).toContain('# J9 Assess the mother');
  });

  it('chunks into maternal chunks that cite the chart and page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcpnc-'));
    writeFileSync(join(dir, 'who-pcpnc-2015.md'), buildPcpncMarkdown(PAGES));
    const chunks = chunkCorpus(loadCorpus(dir));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.pathway === 'maternal')).toBe(true);
    const d28 = chunks.find((c) => c.section.startsWith('D28'));
    expect(d28?.pageFrom).toBe(91);
    expect(d28?.title).toMatch(/Postpartum and Newborn Care/);
  });

  it('writes the verified document into the corpus directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcpnc-'));
    // The real PDF cannot be committed, so the digest is stubbed to the pinned value.
    const path = await fetchPcpnc(
      dir,
      async () => FAKE_PDF,
      async () => PAGES,
      () => PCPNC_SHA256,
    );
    expect(path).toBe(join(dir, 'who-pcpnc-2015.md'));
    expect(loadCorpus(dir)[0]?.domain).toBe('maternal');
  });

  it('falls through to the next WHO address when one fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcpnc-'));
    const tried: string[] = [];
    await fetchPcpnc(
      dir,
      async (url) => {
        tried.push(url);
        if (tried.length === 1) throw new Error('HTTP 403');
        return FAKE_PDF;
      },
      async () => PAGES,
      () => PCPNC_SHA256,
    );
    expect(tried).toHaveLength(2);
  });

  it('refuses to index a page that extracted nothing', () => {
    expect(() => buildPcpncMarkdown(new Map([[22, 'text']]))).toThrow(/extracted no text/);
  });

  it('collapses whitespace without merging paragraphs', () => {
    expect(cleanPageText('a   b\n\n\n\nc  \r\n d')).toBe('a b\n\nc\nd');
  });
});
