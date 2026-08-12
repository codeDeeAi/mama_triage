import {
  chunkDocument,
  estimateTokens,
  inferPathway,
  inferTopics,
  toBlocks,
} from '../../../src/rag/chunk';

const doc = {
  documentSlug: 'who-imci',
  title: 'IMCI Chart Booklet',
  publisher: 'WHO',
};

describe('estimateTokens', () => {
  it('scales with length', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('   ')).toBeGreaterThanOrEqual(1);
  });
});

describe('toBlocks', () => {
  it('separates headings from prose', () => {
    const blocks = toBlocks('# Title\n\nSome prose here.');
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'Title', depth: 1 });
    expect(blocks[1]?.kind).toBe('paragraph');
  });

  it('groups consecutive list items into one block', () => {
    const blocks = toBlocks('- one\n- two\n- three');
    const lists = blocks.filter((b) => b.kind === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0]?.text).toContain('one');
    expect(lists[0]?.text).toContain('three');
  });

  it('recognises numbered lists', () => {
    expect(toBlocks('1. first\n2. second').filter((b) => b.kind === 'list')).toHaveLength(1);
  });

  it('groups table rows into one block', () => {
    const blocks = toBlocks('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(blocks.filter((b) => b.kind === 'table')).toHaveLength(1);
  });

  it('does not merge a list into the paragraph that introduces it', () => {
    const blocks = toBlocks('Check for these signs:\n- not feeding\n- convulsions');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });

  it('consumes page markers and attaches page numbers', () => {
    const blocks = toBlocks('[[page:12]]\nSome text on page twelve.');
    expect(blocks[0]?.page).toBe(12);
    expect(blocks[0]?.text).not.toContain('page:12');
  });

  it('handles an empty document', () => {
    expect(toBlocks('')).toEqual([]);
  });
});

describe('inferPathway', () => {
  it('detects neonatal content', () => {
    expect(inferPathway('Assess the young infant for danger signs')).toBe('neonatal');
    expect(inferPathway('newborn jaundice assessment')).toBe('neonatal');
  });

  it('detects maternal content', () => {
    expect(inferPathway('postpartum haemorrhage management')).toBe('maternal');
    expect(inferPathway('signs of eclampsia in the mother')).toBe('maternal');
  });

  it('returns unset for mixed content, keeping it available to both pathways', () => {
    expect(inferPathway('care of the mother and her newborn baby')).toBe('unset');
  });

  it('returns unset for generic content', () => {
    expect(inferPathway('wash your hands before the examination')).toBe('unset');
  });

  it('treats breastfeeding content as neonatal, not ambiguous', () => {
    // "breast" alone must not read as maternal: newborn feeding guidance is full of it,
    // and tagging it ambiguous would surface neonatal content in maternal assessments.
    expect(
      inferPathway('A newborn that cannot attach to the breast is showing a danger sign'),
    ).toBe('neonatal');
  });

  it('still detects maternal breast pathology', () => {
    expect(inferPathway('Examine for mastitis, engorgement and cracked nipples')).toBe(
      'maternal',
    );
  });
});

describe('inferTopics', () => {
  it('tags clinical topics', () => {
    const topics = inferTopics('Check for fever and convulsions, then refer urgently');
    expect(topics).toEqual(expect.arrayContaining(['fever', 'eclampsia', 'referral']));
  });

  it('returns an empty list when nothing matches', () => {
    expect(inferTopics('introduction and acknowledgements')).toEqual([]);
  });
});

describe('chunkDocument', () => {
  it('produces chunks with stable, sequential IDs', () => {
    const text = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\nBody text ${i}. `.repeat(10)).join('\n\n');
    const chunks = chunkDocument({ ...doc, text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.chunkId).toBe('who-imci#1');
    expect(chunks[1]?.chunkId).toBe('who-imci#2');
    expect(new Set(chunks.map((c) => c.chunkId)).size).toBe(chunks.length);
  });

  it('records the heading path on every chunk', () => {
    const text = '# Assess\n\n## Young infant\n\n### Danger signs\n\nNot able to feed.';
    const chunks = chunkDocument({ ...doc, text });
    expect(chunks[0]?.section).toBe('Assess > Young infant > Danger signs');
  });

  it('prepends the heading path to the embedded text', () => {
    // "Not able to feed" alone means nothing to an embedding model without its section.
    const text = '# Assess\n\n## Danger signs\n\nNot able to feed.';
    const chunks = chunkDocument({ ...doc, text });
    expect(chunks[0]?.text).toContain('Assess > Danger signs');
    expect(chunks[0]?.text).toContain('Not able to feed');
  });

  it('pops the heading stack when a sibling section starts', () => {
    const text =
      '# A\n\n## A1\n\nText under A1.\n\n## A2\n\nText under A2.';
    const chunks = chunkDocument({ ...doc, text, });
    const sections = chunks.map((c) => c.section);
    expect(sections.some((s) => s === 'A > A1')).toBe(true);
    expect(sections.some((s) => s === 'A > A2')).toBe(true);
  });

  it('attributes content to its own section, never the previous one', () => {
    // Citation correctness: if a short section were held open, the NEXT section's text
    // would be labelled with the previous heading, sending a reviewer tracing the claim
    // to the wrong page of the guideline.
    const text =
      '# Assess\n\n## Fever\n\nShort fever text.\n\n## Bleeding\n\nBleeding guidance text.';
    const chunks = chunkDocument({ ...doc, text });

    const bleeding = chunks.find((c) => c.text.includes('Bleeding guidance text'));
    expect(bleeding?.section).toBe('Assess > Bleeding');
    expect(bleeding?.text).not.toContain('Short fever text');
  });

  it('does not carry overlap across a section boundary', () => {
    const text =
      '## Section One\n\n' +
      `${'Content of section one. '.repeat(20)}\n\n` +
      '## Section Two\n\n' +
      'Content of section two.';
    const chunks = chunkDocument({ ...doc, text }, { maxTokens: 200, overlapTokens: 80 });

    const two = chunks.filter((c) => c.section.includes('Section Two'));
    expect(two.length).toBeGreaterThan(0);
    for (const c of two) {
      expect(c.text).not.toContain('Content of section one');
    }
  });

  it('NEVER splits a danger-sign list across chunks', () => {
    // The clinically critical guarantee: a truncated danger-sign list read as complete
    // is how a system misses an emergency.
    const items = Array.from({ length: 60 }, (_, i) => `- danger sign number ${i}`).join('\n');
    const text = `## Danger signs\n\nCheck for the following:\n${items}`;

    const chunks = chunkDocument({ ...doc, text }, { maxTokens: 100 });
    const containing = chunks.filter((c) => c.text.includes('danger sign number 0'));

    expect(containing).toHaveLength(1);
    // The chunk holding the first item holds the last one too.
    expect(containing[0]!.text).toContain('danger sign number 59');
  });

  it('never splits a table across chunks', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `| row ${i} | value ${i} |`).join('\n');
    const text = `## Assessment table\n\n${rows}`;
    const chunks = chunkDocument({ ...doc, text }, { maxTokens: 100 });
    const containing = chunks.filter((c) => c.text.includes('row 0'));
    expect(containing).toHaveLength(1);
    expect(containing[0]!.text).toContain('row 49');
  });

  it('keeps ordinary chunks near the token budget', () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i}. ${'clinical guidance text. '.repeat(12)}`,
    ).join('\n\n');
    const chunks = chunkDocument({ ...doc, text: paragraphs }, { maxTokens: 300 });

    // Allow headroom for the heading path prefix and the final chunk.
    for (const c of chunks.slice(0, -1)) {
      expect(c.tokenCount).toBeLessThanOrEqual(400);
    }
  });

  it('overlaps consecutive chunks so context is not lost at a boundary', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}. ${'text '.repeat(30)}`,
    ).join('\n\n');
    const chunks = chunkDocument({ ...doc, text: paragraphs }, { maxTokens: 200, overlapTokens: 60 });

    expect(chunks.length).toBeGreaterThan(2);
    // Some paragraph appears in more than one chunk.
    const counts = new Map<string, number>();
    for (const c of chunks) {
      for (let i = 0; i < 20; i++) {
        if (c.text.includes(`Paragraph ${i}.`)) counts.set(String(i), (counts.get(String(i)) ?? 0) + 1);
      }
    }
    expect([...counts.values()].some((n) => n > 1)).toBe(true);
  });

  it('tags pathway and topics per chunk', () => {
    const text =
      '## Young infant danger signs\n\nThe newborn is not able to feed and has convulsions.';
    const chunks = chunkDocument({ ...doc, text });
    expect(chunks[0]?.pathway).toBe('neonatal');
    expect(chunks[0]?.topics).toEqual(expect.arrayContaining(['feeding']));
  });

  it('records page ranges when markers are present', () => {
    const text = '[[page:5]]\n## Section\n\nSome text.\n\n[[page:6]]\nMore text.';
    const chunks = chunkDocument({ ...doc, text });
    expect(chunks[0]?.pageFrom).toBeGreaterThanOrEqual(5);
  });

  it('carries document identity onto every chunk', () => {
    const chunks = chunkDocument({ ...doc, docVersion: '2014', text: '## S\n\nSome text here.' });
    expect(chunks[0]).toMatchObject({
      documentSlug: 'who-imci',
      title: 'IMCI Chart Booklet',
      publisher: 'WHO',
      docVersion: '2014',
    });
  });

  it('returns no chunks for an empty or heading-only document', () => {
    expect(chunkDocument({ ...doc, text: '' })).toEqual([]);
    expect(chunkDocument({ ...doc, text: '# Only a heading' })).toEqual([]);
  });

  it('handles a document with no headings at all', () => {
    const chunks = chunkDocument({ ...doc, text: 'Just prose with no structure at all here.' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.section).toBe('');
  });
});
