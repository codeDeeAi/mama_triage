/**
 * PDF → Markdown extraction for the guideline corpus.
 *
 * Deliberately a **separate, reviewable step** from ingestion (see knowledge/SOURCES.md).
 * Extraction quality varies enough between documents that it must be checked by eye
 * before anything is indexed: a garbled danger-sign list is worse than no guidance.
 *
 * Emits `[[page:N]]` markers, which the chunker consumes into page ranges so a citation
 * points a reviewer at the right page of the source PDF.
 *
 * Run with: npm run kb:extract -- <input.pdf> <output.md>
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Some WHO PDFs embed text with a custom font encoding in which every character is
 * shifted by a fixed offset — "3DJHRI" renders as "Page of", "&" as "C". Left alone,
 * whole clinical phrases ("Fever ... or above") become unreadable and would be silently
 * indexed as noise.
 *
 * Digits are usually absent from these runs entirely rather than shifted, so numeric
 * thresholds recovered this way are NOT trustworthy and are flagged for manual checking.
 */
const ENCODING_SHIFT = 29;

/** True when a token looks like shifted-encoding output rather than real text. */
export function looksShifted(token: string): boolean {
  if (token.length < 4) return false;
  // Shifted text is dominated by uppercase letters and punctuation, with no spaces and
  // no lowercase vowels in normal positions.
  if (!/^[A-Z0-9&()[\]{}<>?@^_`|~!"#$%'*+,\-./:;=\\]+$/.test(token)) return false;
  const decoded = shiftDecode(token);
  // Accept only if decoding yields something that looks like English words.
  return /^[A-Za-z ]+$/.test(decoded) && /[aeiou]/.test(decoded);
}

export function shiftDecode(token: string): string {
  return [...token]
    .map((ch) => {
      const code = ch.charCodeAt(0) + ENCODING_SHIFT;
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : ch;
    })
    .join('');
}

export interface ExtractionReport {
  markdown: string;
  pages: number;
  charsExtracted: number;
  tokensRepaired: number;
  /** Lines that still contain suspected garbling after repair. */
  suspectLines: string[];
}

/**
 * Convert extracted page text into the Markdown shape the chunker expects.
 *
 * Heuristics only. A heading is a short ALL-CAPS line; a bullet is a line beginning with
 * a marker or a short clinical phrase inside a list run. This is why the output must be
 * reviewed before it is committed.
 */
export function toMarkdown(pageTexts: readonly string[]): ExtractionReport {
  const out: string[] = [];
  let repaired = 0;
  const suspect: string[] = [];

  pageTexts.forEach((raw, i) => {
    out.push(`[[page:${i + 1}]]`);
    out.push('');

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        out.push('');
        continue;
      }

      // Repair shifted-encoding tokens word by word.
      const repairedLine = trimmed
        .split(/(\s+)/)
        .map((token) => {
          if (looksShifted(token)) {
            repaired += 1;
            return shiftDecode(token);
          }
          return token;
        })
        .join('');

      // Anything still dominated by unreadable runs is flagged rather than silently kept.
      if (/[A-Z]{6,}[a-z]{0,2}[A-Z]{4,}/.test(repairedLine.replace(/\s/g, ''))) {
        suspect.push(`p${i + 1}: ${repairedLine.slice(0, 100)}`);
      }

      // A short ALL-CAPS line is almost always a chart heading in these documents.
      const isHeading =
        repairedLine.length <= 80 &&
        /^[A-Z0-9][A-Z0-9 ,'()/&+-]*$/.test(repairedLine) &&
        repairedLine.split(/\s+/).length <= 12 &&
        repairedLine.length >= 4;

      if (isHeading) {
        out.push('');
        out.push(`## ${titleCaseIfShouting(repairedLine)}`);
        out.push('');
        continue;
      }

      out.push(repairedLine);
    }
    out.push('');
  });

  const markdown = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    markdown,
    pages: pageTexts.length,
    charsExtracted: markdown.length,
    tokensRepaired: repaired,
    suspectLines: suspect,
  };
}

function titleCaseIfShouting(s: string): string {
  // Keep genuine acronyms, soften long shouted headings for readability.
  if (s.length <= 6) return s;
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Imci|Who|Hiv|Aids|Art|Ors)\b/g, (m) => m.toUpperCase());
}

/** Read a PDF and return its per-page text. */
export async function readPdfPages(path: string): Promise<string[]> {
  // Imported lazily: pdf-parse is a build-time tool, not a runtime dependency of the
  // service, and should not be loaded when the server boots.
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText(): Promise<{ text: string; pages?: unknown[] }>;
      destroy(): Promise<void>;
    };
  };

  const parser = new PDFParse({ data: new Uint8Array(readFileSync(path)) });
  try {
    const res = await parser.getText();
    // pdf-parse emits "-- N of M --" separators between pages.
    return res.text.split(/^-- \d+ of \d+ --$/m).slice(1);
  } finally {
    await parser.destroy();
  }
}

export interface FrontMatterInput {
  slug: string;
  title: string;
  publisher: string;
  version?: string;
  sourceUri?: string;
  retrievedAt?: string;
}

export function withFrontMatter(markdown: string, meta: FrontMatterInput): string {
  const lines = ['---', `slug: ${meta.slug}`, `title: ${meta.title}`, `publisher: ${meta.publisher}`];
  if (meta.version) lines.push(`version: "${meta.version}"`);
  if (meta.sourceUri) lines.push(`source_uri: ${meta.sourceUri}`);
  if (meta.retrievedAt) lines.push(`retrieved_at: ${meta.retrievedAt}`);
  lines.push('---', '');
  return lines.join('\n') + markdown + '\n';
}

/* istanbul ignore next -- CLI wiring */
async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write(
      'usage: npm run kb:extract -- <input.pdf> <output.md> [--slug s --title t --publisher p --uri u --version v]\n',
    );
    process.exit(1);
  }

  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };

  const pages = await readPdfPages(input);
  const report = toMarkdown(pages);

  const md = withFrontMatter(report.markdown, {
    slug: arg('slug') ?? 'document',
    title: arg('title') ?? 'Untitled',
    publisher: arg('publisher') ?? 'Unknown',
    ...(arg('version') ? { version: arg('version') as string } : {}),
    ...(arg('uri') ? { sourceUri: arg('uri') as string } : {}),
    retrievedAt: new Date().toISOString().slice(0, 10),
  });

  writeFileSync(output, md, 'utf8');

  const w = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  w(`Extracted ${report.pages} pages → ${output}`);
  w(`  characters:        ${report.charsExtracted.toLocaleString()}`);
  w(`  encoding repairs:  ${report.tokensRepaired}`);
  w(`  suspect lines:     ${report.suspectLines.length}`);
  w('');
  if (report.suspectLines.length > 0) {
    w('Lines that may still be garbled — CHECK THESE AGAINST THE PDF BY EYE:');
    for (const line of report.suspectLines.slice(0, 15)) w(`  ${line}`);
    if (report.suspectLines.length > 15) w(`  ... and ${report.suspectLines.length - 15} more`);
    w('');
  }
  w('IMPORTANT: numeric thresholds (temperatures, respiratory rates) are frequently');
  w('lost or corrupted by PDF text extraction. Verify every number against the source');
  w('document before this file is indexed or cited.');
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`extraction failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
