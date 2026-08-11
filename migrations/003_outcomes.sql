-- Up Migration
-- Triage outcomes: the classification produced for a completed assessment.
--
-- Three urgency columns are kept deliberately. `urgency` is what the mother was told;
-- `urgency_llm` and `urgency_rules` record what each layer independently proposed. The
-- disagreement between them is a reportable finding (plan §13.3) and the evidence for
-- the hybrid architecture argument in Chapter 4.

CREATE TABLE triage_outcomes (
    id             BIGSERIAL PRIMARY KEY,
    session_id     UUID      NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    pathway        pathway_t NOT NULL,

    urgency        urgency_t NOT NULL,   -- final, post-ratchet: what was actually sent
    urgency_llm    urgency_t,            -- the model's unaided proposal
    urgency_rules  urgency_t,            -- the deterministic layer's unaided proposal

    -- 'rules' | 'safety_check' | 'low_confidence' | NULL
    escalated_by   VARCHAR(30),

    red_flags      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- RedFlagHit[]
    slots          JSONB NOT NULL DEFAULT '{}'::jsonb,
    citations      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{chunk_id, claim}]
    rationale      TEXT,                                -- clinician-facing, never shown

    -- Reproducibility: an outcome is meaningless for research without knowing exactly
    -- which model and which prompt produced it.
    model          VARCHAR(80) NOT NULL,
    prompt_version VARCHAR(20) NOT NULL,

    input_tokens   INTEGER,
    output_tokens  INTEGER,
    latency_ms     INTEGER,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outcomes_urgency ON triage_outcomes (urgency, created_at DESC);
CREATE INDEX idx_outcomes_session ON triage_outcomes (session_id);

-- Down Migration
DROP TABLE IF EXISTS triage_outcomes;
