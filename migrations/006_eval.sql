-- Up Migration
-- Evaluation harness storage (Objective 4).
--
-- Results live in the database rather than in flat files so that the metrics in
-- Chapter 4 are computed by query from a definition, not by analysis code written once
-- and trusted. In particular `under_triaged` is a GENERATED column: the single most
-- safety-critical figure in the report is derived by PostgreSQL from its definition and
-- cannot drift.

CREATE TABLE eval_runs (
    id             BIGSERIAL PRIMARY KEY,
    run_label      VARCHAR(80) NOT NULL,
    model          VARCHAR(80) NOT NULL,
    prompt_version VARCHAR(20) NOT NULL,

    -- Prompts are iterated against 'dev' and reported on 'holdout'. Tuning on the test
    -- set and reporting it is the commonest methodological error in work like this.
    split          VARCHAR(20) NOT NULL CHECK (split IN ('dev', 'holdout', 'smoke')),

    -- Guards against reporting results produced by an unverified red-flag register.
    register_verified BOOLEAN NOT NULL DEFAULT FALSE,

    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at    TIMESTAMPTZ
);

CREATE TABLE eval_results (
    id            BIGSERIAL PRIMARY KEY,
    run_id        BIGINT      NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
    scenario_id   VARCHAR(60) NOT NULL,
    pathway       pathway_t   NOT NULL,
    language      lang_t      NOT NULL,

    expected      urgency_t   NOT NULL,   -- clinician-adjudicated gold standard
    actual        urgency_t   NOT NULL,

    -- The headline safety metric. Predicting a LOWER tier than the gold standard is an
    -- under-triage; on an emergency case it is the failure mode that costs lives.
    under_triaged BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN expected = 'emergency'
                 AND actual IN ('facility_visit', 'self_care') THEN TRUE
            WHEN expected = 'facility_visit'
                 AND actual = 'self_care'                      THEN TRUE
            ELSE FALSE
        END
    ) STORED,

    over_triaged  BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN expected = 'self_care'
                 AND actual IN ('facility_visit', 'emergency') THEN TRUE
            WHEN expected = 'facility_visit'
                 AND actual = 'emergency'                      THEN TRUE
            ELSE FALSE
        END
    ) STORED,

    red_flags     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    turns         INTEGER,
    latency_ms    INTEGER,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    transcript    JSONB,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (run_id, scenario_id)
);

CREATE INDEX idx_eval_under    ON eval_results (run_id, under_triaged);
CREATE INDEX idx_eval_scenario ON eval_results (scenario_id);

-- Down Migration
DROP TABLE IF EXISTS eval_results;
DROP TABLE IF EXISTS eval_runs;
