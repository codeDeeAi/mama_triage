-- Up Migration
-- Messages: every inbound and outbound turn within a session.
--
-- `body_redacted` holds PII-stripped text only (src/privacy/redact.ts). Raw message
-- bodies are never persisted, satisfying the privacy requirement in Chapter 3 §3.2.3
-- and the anonymised-transcript commitment in §1.4.

CREATE TYPE direction_t AS ENUM ('inbound', 'outbound');

CREATE TABLE messages (
    id            BIGSERIAL PRIMARY KEY,
    session_id    UUID        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    direction     direction_t NOT NULL,

    -- Meta's message ID. UNIQUE is what makes webhook retries harmless: a duplicated
    -- delivery cannot produce a second stored message or a second outbound reply.
    wa_message_id VARCHAR(128) UNIQUE,

    body_redacted TEXT        NOT NULL,
    detected_lang lang_t,

    -- Outbound only: inbound receipt to outbound send. Feeds the latency figures in
    -- the evaluation report (plan §13.3).
    latency_ms    INTEGER,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON messages (session_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS messages;
DROP TYPE IF EXISTS direction_t;
