-- Up Migration
-- Sessions: one triage conversation. Chapter 3, section 3.4.1.
--
-- Privacy: the mother's phone number is NEVER stored. `wa_id_hash` is
-- HMAC-SHA256(phone, PHONE_HASH_PEPPER) with the pepper held in Secret Manager, so the
-- database is useless for identifying a person even if it leaks, while still allowing
-- session continuity across messages.

CREATE TYPE pathway_t AS ENUM ('unset', 'maternal', 'neonatal');
CREATE TYPE urgency_t AS ENUM ('self_care', 'facility_visit', 'emergency');

-- 'pcm' is the ISO 639-3 code for Nigerian Pidgin.
CREATE TYPE lang_t AS ENUM ('en', 'pcm');

CREATE TYPE session_state_t AS ENUM (
    'new',
    'awaiting_consent',
    'choosing_pathway',
    'assessing',
    'confirming',
    'completed',
    'abandoned',
    'escalated'
);

CREATE TABLE sessions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_id_hash       CHAR(64)        NOT NULL,
    pathway          pathway_t       NOT NULL DEFAULT 'unset',
    state            session_state_t NOT NULL DEFAULT 'new',
    language         lang_t          NOT NULL DEFAULT 'en',
    slots            JSONB           NOT NULL DEFAULT '{}'::jsonb,

    -- Ratchet high-water mark. Enforced monotonic by trigger below as well as in
    -- application code (src/safety/ratchet.ts): the guarantee must not depend on a
    -- single layer being correct.
    urgency_current  urgency_t,

    consent_at       TIMESTAMPTZ,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);

CREATE INDEX idx_sessions_wa_hash_active ON sessions (wa_id_hash, last_activity_at DESC);
CREATE INDEX idx_sessions_state          ON sessions (state);

-- Database-level enforcement of the urgency ratchet. An UPDATE that attempts to lower
-- urgency_current is rejected outright rather than silently absorbed.
CREATE OR REPLACE FUNCTION enforce_urgency_ratchet() RETURNS TRIGGER AS $$
DECLARE
    rank_old INT;
    rank_new INT;
BEGIN
    IF OLD.urgency_current IS NULL OR NEW.urgency_current IS NULL THEN
        RETURN NEW;
    END IF;

    rank_old := CASE OLD.urgency_current
                    WHEN 'self_care' THEN 0 WHEN 'facility_visit' THEN 1 ELSE 2 END;
    rank_new := CASE NEW.urgency_current
                    WHEN 'self_care' THEN 0 WHEN 'facility_visit' THEN 1 ELSE 2 END;

    IF rank_new < rank_old THEN
        RAISE EXCEPTION
            'urgency ratchet violation: cannot lower session % from % to %',
            OLD.id, OLD.urgency_current, NEW.urgency_current;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sessions_urgency_ratchet
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_urgency_ratchet();

-- Down Migration
DROP TRIGGER IF EXISTS trg_sessions_urgency_ratchet ON sessions;
DROP FUNCTION IF EXISTS enforce_urgency_ratchet();
DROP TABLE IF EXISTS sessions;
DROP TYPE IF EXISTS session_state_t;
DROP TYPE IF EXISTS lang_t;
DROP TYPE IF EXISTS urgency_t;
DROP TYPE IF EXISTS pathway_t;
