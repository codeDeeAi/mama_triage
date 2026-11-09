/**
 * Fetch, verify and extract the postpartum chapters of WHO PCPNC (2015) into the corpus.
 *
 * WHO, *Pregnancy, Childbirth, Postpartum and Newborn Care: A Guide for Essential
 * Practice*, 3rd edition (2015), ISBN 978 92 4 154935 6, is the guide the eight
 * non-haemorrhage maternal red-flag rules are traced to (see redFlags.ts). Until this
 * script existed it was not indexed, so retrieval had nothing to say about postpartum
 * fever, pre-eclampsia, breathing difficulty, wound infection, lochia or mastitis.
 *
 * Why it is fetched at build time rather than committed:
 *   The guide is a WHO publication with all rights reserved. Indexing it for retrieval is
 *   use; committing its extracted text to a public repository would be redistribution.
 *   So the repository holds this script, the exact URL and the SHA-256 of the PDF, and
 *   the Docker build downloads the PDF from WHO's own repository, checks the hash and
 *   writes the extracted chapters into the image's corpus. The generated file is
 *   git-ignored.
 *
 * Why the hash is checked:
 *   An evaluation is only reproducible if every run used the same knowledge base. A
 *   silently re-issued or truncated PDF would change what the model is shown. A mismatch
 *   therefore fails the build instead of indexing a different document.
 *
 * Only the chapters relevant to a postpartum mother are extracted — rapid assessment (B),
 * care after delivery (D21–D28), postpartum care (E) and the mother's breast (J9) — so
 * antenatal and labour guidance cannot be retrieved into a postpartum assessment.
 *
 * Run with: node dist/rag/fetchPcpnc.js <corpus-dir>
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PCPNC_URL =
  'https://iris.who.int/server/api/core/bitstreams/e9f751fd-6eab-42cb-9e0c-0eb86a0365bb/content';

/** Tried in order; each must yield the same pinned bytes. */
export const PCPNC_URLS: readonly string[] = [
  PCPNC_URL,
  'https://iris.who.int/bitstream/handle/10665/249580/9789241549356-eng.pdf',
  'https://apps.who.int/iris/bitstream/handle/10665/249580/9789241549356-eng.pdf',
];
export const PCPNC_SHA256 = '2740dcff2c0fbc550a86e25439b9955e7b62f6993b3715f3f352f556a814d5ae';
export const PCPNC_FILE = 'who-pcpnc-2015.md';

/**
 * PDF page → chart code and title, read from the guide itself. PCPNC is paginated by
 * chart code, so the code is what a clinician would look up; the PDF page is kept as
 * the page number so a citation can also be found in the file.
 */
export const PCPNC_PAGES: ReadonlyArray<{ page: number; code: string; title: string }> = [
  { page: 22, code: 'B1', title: 'Quick check, rapid assessment and management of women of childbearing age' },
  { page: 23, code: 'B2', title: 'Quick check' },
  { page: 24, code: 'B3', title: 'Rapid assessment and management: airway and breathing, circulation (shock)' },
  { page: 25, code: 'B4', title: 'Rapid assessment and management: vaginal bleeding' },
  { page: 26, code: 'B5', title: 'Rapid assessment and management: vaginal bleeding postpartum' },
  { page: 27, code: 'B6', title: 'Rapid assessment and management: emergency signs' },
  { page: 28, code: 'B7', title: 'Rapid assessment and management: priority signs' },
  { page: 84, code: 'D21', title: 'Assess the mother after delivery' },
  { page: 85, code: 'D22', title: 'Respond to problems during and immediately after childbirth (1)' },
  { page: 86, code: 'D23', title: 'Respond to problems during and immediately after childbirth (2)' },
  { page: 87, code: 'D24', title: 'Respond to problems immediately postpartum' },
  { page: 88, code: 'D25', title: 'Give preventive measures' },
  { page: 89, code: 'D26', title: 'Advise on postpartum care' },
  { page: 90, code: 'D27', title: 'Counsel on birth spacing and family planning' },
  { page: 91, code: 'D28', title: 'Advise on when to return' },
  { page: 94, code: 'E1', title: 'Postpartum care' },
  { page: 95, code: 'E2', title: 'Postpartum examination of the mother (up to 6 weeks)' },
  { page: 96, code: 'E3', title: 'Respond to observed signs or volunteered problems: elevated diastolic blood pressure' },
  { page: 97, code: 'E4', title: 'Respond to observed signs or volunteered problems: pallor, anaemia' },
  { page: 98, code: 'E5', title: 'Respond to observed signs or volunteered problems: HIV status' },
  { page: 99, code: 'E6', title: 'Respond to observed signs or volunteered problems: heavy vaginal bleeding, fever or foul-smelling lochia' },
  { page: 100, code: 'E7', title: 'Respond to observed signs or volunteered problems: dribbling urine, pus or perineal pain, feeling unhappy' },
  { page: 101, code: 'E8', title: 'Respond to observed signs or volunteered problems: vaginal discharge, breast problem' },
  { page: 102, code: 'E9', title: 'Respond to observed signs or volunteered problems: cough or breathing difficulty' },
  { page: 103, code: 'E10', title: 'Respond to observed signs or volunteered problems: HIV, smoking, alcohol, violence' },
  { page: 138, code: 'J9', title: "Assess the mother's breasts if complaining of nipple or breast pain" },
];

/** Fixed, so the generated file — and therefore the index hash — is identical on every build. */
const RETRIEVED_AT = '2026-11-09';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Tidy one page of extracted text into paragraphs the chunker can split on. */
export function cleanPageText(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build the corpus file from the extracted text of the selected pages. */
export function buildPcpncMarkdown(pageText: ReadonlyMap<number, string>): string {
  const lines = [
    '---',
    'slug: who-pcpnc-2015',
    'title: "Pregnancy, Childbirth, Postpartum and Newborn Care: A Guide for Essential Practice (postpartum chapters)"',
    'publisher: WHO',
    'version: "3rd edition, 2015"',
    `source_uri: ${PCPNC_URL}`,
    `retrieved_at: ${RETRIEVED_AT}`,
    'domain: maternal',
    '---',
    '',
  ];
  for (const { page, code, title } of PCPNC_PAGES) {
    const text = pageText.get(page);
    if (text === undefined || text.trim().length === 0) {
      throw new Error(`PCPNC page ${page} (${code}) extracted no text; refusing to index a gap.`);
    }
    lines.push(`[[page:${page}]]`, '', `# ${code} ${title}`, '', cleanPageText(text), '');
  }
  return lines.join('\n');
}

/**
 * Extract the selected pages' text from the PDF.
 *
 * Exercised against a real PDF by the Docker build, not under Jest: pdf-parse is an ES
 * module loaded by dynamic import, which Jest's CommonJS runtime cannot execute.
 */
/* istanbul ignore next */
export async function extractPcpncPages(pdf: Uint8Array): Promise<Map<number, string>> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText(params?: { partial?: number[] }): Promise<{ pages: Array<{ num: number; text: string }> }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: pdf });
  try {
    const res = await parser.getText({ partial: PCPNC_PAGES.map((p) => p.page) });
    return new Map(res.pages.map((p) => [p.num, p.text]));
  } finally {
    await parser.destroy();
  }
}

/** Download, verify, extract and write. Returns the path written. */
export async function fetchPcpnc(
  corpusDir: string,
  download: (url: string) => Promise<Uint8Array> = defaultDownload,
  extract: (pdf: Uint8Array) => Promise<Map<number, string>> = extractPcpncPages,
  hash: (pdf: Uint8Array) => string = sha256Hex,
): Promise<string> {
  const problems: string[] = [];
  let pdf: Uint8Array | undefined;
  for (const url of PCPNC_URLS) {
    try {
      const bytes = await download(url);
      const digest = hash(bytes);
      if (digest === PCPNC_SHA256) {
        pdf = bytes;
        break;
      }
      problems.push(`${url}: hash mismatch, got ${digest} (${bytes.byteLength} bytes)`);
    } catch (err) {
      problems.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!pdf) {
    throw new Error(
      `WHO PCPNC PDF could not be obtained with the pinned SHA-256 ${PCPNC_SHA256}. ` +
        'Refusing to index a different document than the one the evaluation used.\n' +
        problems.join('\n'),
    );
  }
  const markdown = buildPcpncMarkdown(await extract(pdf));
  const out = join(corpusDir, PCPNC_FILE);
  writeFileSync(out, markdown, 'utf8');
  return out;
}

/* istanbul ignore next -- network */
async function defaultDownload(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'user-agent': 'mama-triage-kb-build' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/* istanbul ignore next -- CLI wiring */
if (require.main === module) {
  const dir = process.argv[2] ?? 'knowledge/sources';
  fetchPcpnc(dir)
    .then((path) => process.stdout.write(`WHO PCPNC (2015) postpartum chapters written to ${path}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
