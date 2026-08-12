# Knowledge base corpus

Source documents for the RAG pipeline. Everything in `sources/` is chunked, embedded, and
becomes citable clinical guidance, so provenance is mandatory rather than nice to have.

## ⚠️ Current state

`sources/` contains **one placeholder file only**. It exists so the ingestion pipeline can
be built and tested before the real guidelines are available. It is **not clinical
guidance** and its `publisher` field is deliberately set to a string that makes any
citation derived from it obviously wrong in output.

**Before any evaluation run, the placeholder must be deleted and replaced with the real
extracted guidelines.**

## Required documents

| Document | Publisher | Status |
|---|---|---|
| Integrated Management of Childhood Illness (IMCI) chart booklet — young infant 0–2 months | WHO | ⬜ to obtain |
| IMCI — sick child 2 months to 5 years | WHO | ⬜ to obtain |
| Basic Emergency Obstetric and Newborn Care (BEmONC) protocols | FMOH Nigeria | ⬜ to obtain |
| National guidelines for postnatal care | FMOH Nigeria | ⬜ to obtain |

Ask your supervisor which FMOH edition the department can supply directly — sourcing the
correct Nigerian protocol edition is the item on this list most likely to slip.

## Format

One Markdown file per document in `sources/`, with front matter:

```markdown
---
slug: who-imci-young-infant
title: IMCI Chart Booklet — Young Infant Age Up To 2 Months
publisher: WHO
version: 2014
source_uri: https://www.who.int/...
retrieved_at: 2026-08-12
---

# Assess and classify the sick young infant

## Check for very severe disease

[[page:12]]
Ask the mother about the infant's problem. Then check for the following danger signs:

- Not able to feed
- Convulsions
...
```

Rules:

- `title` and `publisher` are **required**; ingestion refuses a file without them, because
  a chunk that cannot be traced to a source cannot be cited in the report.
- `[[page:N]]` markers are consumed by the chunker and recorded as page ranges, so a
  citation points a reviewer to the right page of the source PDF. Preserve them during
  extraction.
- Headings define the section path attached to every chunk. Keep the document's real
  heading structure — it is what makes a citation legible.
- Keep danger-sign lists and assessment tables as Markdown lists/tables. The chunker
  guarantees it will never split one across chunks, and that guarantee relies on them
  being recognisable as lists and tables.

## Extraction

PDF extraction is deliberately **not** part of the ingestion step. Extraction quality
varies too much between documents to trust unattended, and a garbled danger-sign list is
worse than no guidance. Extract to Markdown as a separate, reviewable pass, check the
output by eye against the PDF, then commit it here.

The file is hashed on ingest (`clinical_documents.sha256`). Any edit changes the hash,
which is the signal that the index must be rebuilt before the next evaluation run.

## Rebuilding the index

```bash
npm run kb:ingest      # → knowledge/index/index.json  (git-ignored)
```

The index file is built at Docker build time and shipped read-only inside the image, so an
evaluation run is pinned to an image digest.
