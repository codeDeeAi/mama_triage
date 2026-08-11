-- Up Migration
-- Operational tables: webhook idempotency and the audit trail.

-- Idempotency ledger. The webhook handler claims a message ID here with
-- INSERT ... ON CONFLICT DO NOTHING before doing any work; a Meta retry loses the race
-- and is dropped, so a duplicated delivery cannot produce a duplicate triage message.
CREATE TABLE webhook_events (
    wa_message_id VARCHAR(128) PRIMARY KEY,
    received_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    status        VARCHAR(20)  NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'processed', 'failed', 'ignored'))
);

CREATE INDEX idx_webhook_events_received ON webhook_events (received_at);

-- Audit trail. Safety-relevant events, kept separate from the clinical outcome record.
-- session_id is ON DELETE SET NULL so the audit trail survives session deletion.
CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions (id) ON DELETE SET NULL,

    -- CONSENT_GIVEN, CONSENT_DECLINED, RED_FLAG_HIT, DISTRESS_DETECTED,
    -- EMERGENCY_ISSUED, LLM_FAILOVER, CITATION_REJECTED, RATCHET_BLOCKED_DOWNGRADE,
    -- SAFETY_CHECK_ESCALATED, SESSION_ABANDONED
    event      VARCHAR(60) NOT NULL,

    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_event   ON audit_log (event, created_at DESC);
CREATE INDEX idx_audit_session ON audit_log (session_id);

-- Down Migration
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS webhook_events;
