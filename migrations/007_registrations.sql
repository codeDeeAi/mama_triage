-- Up Migration
-- Registrations: how a mother joins, and on which channel.
--
-- Data minimisation is the design principle here. The only universally required field is
-- a display name — what she would like to be called. A phone number is collected ONLY
-- when she chooses WhatsApp, because that channel cannot address her without one.
--
-- Telegram needs no identifier at all at registration time: she is issued a single-use
-- link token, and her chat is bound to the registration when she opens the bot. That
-- means a Telegram registration holds no contact detail whatsoever until she initiates,
-- which is a materially better privacy position than the WhatsApp path and worth stating
-- in Chapter 5.

CREATE TYPE channel_t AS ENUM ('whatsapp', 'telegram');

CREATE TABLE registrations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What she wants to be called. Free text, shown back to her in the welcome message.
    -- Not a legal name and never used as an identifier.
    display_name  VARCHAR(80) NOT NULL,
    channel       channel_t   NOT NULL,

    -- HMAC of the channel identifier, matching sessions.wa_id_hash so a registration can
    -- be joined to its conversations. NULL for a Telegram registration until she starts
    -- the bot — at which point there is finally something to hash.
    identity_hash CHAR(64),

    -- Single-use token embedded in the t.me deep link. Telegram only.
    link_token    VARCHAR(64) UNIQUE,
    linked_at     TIMESTAMPTZ,

    -- Explicit agreement to be contacted on this channel. Separate from the in-
    -- conversation consent to store a transcript: agreeing to receive a message is not
    -- agreeing to have a clinical conversation recorded.
    contact_consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A WhatsApp registration is useless without an identity; a Telegram one is useless
    -- without a link token. Enforced here so a malformed row cannot exist.
    CONSTRAINT chk_registration_addressable CHECK (
        (channel = 'whatsapp' AND identity_hash IS NOT NULL)
        OR
        (channel = 'telegram' AND link_token IS NOT NULL)
    )
);

CREATE INDEX idx_registrations_identity ON registrations (identity_hash);
CREATE INDEX idx_registrations_token    ON registrations (link_token);

-- Down Migration
DROP TABLE IF EXISTS registrations;
DROP TYPE IF EXISTS channel_t;
