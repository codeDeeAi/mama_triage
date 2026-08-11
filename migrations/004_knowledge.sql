-- Up Migration
-- RAG knowledge base metadata.
--
-- The vectors live in Chroma; this table is the provenance record. `sha256` pins the
-- exact source document, so any triage output can be traced to a specific edition of a
-- specific guideline — which is what "the clinical knowledge base must be updatable
-- without changes to the application code" (Chapter 3 §3.2.3) requires in practice.

CREATE TABLE clinical_documents (
    id              BIGSERIAL PRIMARY KEY,
    title           VARCHAR(300) NOT NULL,
    publisher       VARCHAR(120) NOT NULL,   -- 'WHO' | 'FMOH Nigeria' | ...
    doc_version     VARCHAR(60),
    jurisdiction    VARCHAR(60)  NOT NULL DEFAULT 'NG',
    source_uri      TEXT,
    retrieved_at    DATE,

    -- Corpus integrity. A changed hash means the source was revised and the index
    -- must be rebuilt before the next evaluation run.
    sha256          CHAR(64)     NOT NULL UNIQUE,

    chunk_count     INTEGER      NOT NULL DEFAULT 0,
    embedding_model VARCHAR(80),
    indexed_at      TIMESTAMPTZ
);

CREATE TABLE document_chunks (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT      NOT NULL REFERENCES clinical_documents (id) ON DELETE CASCADE,

    -- Join key to the vector store. Citations returned by the LLM are validated
    -- against this column before anything is sent to the mother.
    chroma_id   VARCHAR(80) NOT NULL UNIQUE,

    section     VARCHAR(300),
    page_from   INTEGER,
    page_to     INTEGER,
    pathway_tag pathway_t   NOT NULL DEFAULT 'unset',
    token_count INTEGER     NOT NULL
);

CREATE INDEX idx_chunks_document ON document_chunks (document_id);
CREATE INDEX idx_chunks_pathway  ON document_chunks (pathway_tag);

-- Down Migration
DROP TABLE IF EXISTS document_chunks;
DROP TABLE IF EXISTS clinical_documents;
