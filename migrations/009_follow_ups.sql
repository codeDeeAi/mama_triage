-- Up Migration
-- Scheduled clinical follow-ups.
--
-- WHO IMCI does not treat follow-up as optional. The young-infant chart specifies fixed
-- intervals — jaundice at 1 day; local bacterial infection, feeding problem, thrush and
-- diarrhoea at 2 days; low weight for age at 14 days. Advising a mother to come back and
-- then having no mechanism to reach her would make that advice decorative.
--
-- The reminder is delivered on the channel she already uses, so no new identifier is
-- needed: identity_hash is the same hash the session is keyed by.

CREATE TYPE followup_status_t AS ENUM ('pending', 'sent', 'failed', 'cancelled');

CREATE TABLE follow_ups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID REFERENCES sessions (id) ON DELETE SET NULL,

    -- Who to contact, and where. Same channel-keyed hash the session uses.
    identity_hash CHAR(64)  NOT NULL,

    -- The plaintext address needed to actually deliver — a Telegram chat ID or a phone
    -- number. Identity hashing is irreversible by design, so a reminder cannot be sent
    -- from the hash alone.
    --
    -- The exposure is bounded rather than accepted wholesale: this is populated only for
    -- the small set of mothers with a follow-up pending, exists only for the one or two
    -- days until it is delivered, and is CLEARED the moment the follow-up is sent,
    -- cancelled or abandoned. The steady state is NULL. That is a deliberate,
    -- explainable trade-off and it is disclosed in the privacy notice.
    recipient     VARCHAR(64),
    channel       channel_t NOT NULL,
    language      lang_t    NOT NULL DEFAULT 'en',
    display_name  VARCHAR(80),

    -- Which IMCI classification triggered this, and the interval it prescribes.
    reason        VARCHAR(60) NOT NULL,
    interval_days INTEGER     NOT NULL,

    due_at        TIMESTAMPTZ NOT NULL,
    status        followup_status_t NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    sent_at       TIMESTAMPTZ,
    last_error    TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The runner's query: everything due and not yet dealt with.
CREATE INDEX idx_followups_due ON follow_ups (status, due_at)
    WHERE status = 'pending';
CREATE INDEX idx_followups_identity ON follow_ups (identity_hash);

-- One pending follow-up per session per reason. Re-running an assessment should not
-- queue a second reminder for the same finding.
CREATE UNIQUE INDEX idx_followups_unique_pending
    ON follow_ups (session_id, reason)
    WHERE status = 'pending';

-- Down Migration
DROP TABLE IF EXISTS follow_ups;
DROP TYPE IF EXISTS followup_status_t;
