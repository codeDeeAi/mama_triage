-- Up Migration
-- Optional SMS reminders.
--
-- SMS cannot carry a triage conversation on this provider: the KudiSMS API has no inbound
-- webhook, so a reply never reaches the server. It can, however, deliver the IMCI
-- follow-up reminders — and it is the only channel that reaches a feature phone with no
-- data connection, which is exactly the population this project targets.
--
-- The cost is a real one and is stated plainly rather than buried: sending an SMS
-- requires a number the system can actually dial, so an opt-in stores the number in
-- RECOVERABLE form. That is a deliberate exception to the hashing used everywhere else.
-- It is specific, informed, and revocable: only for mothers who tick the box, only for
-- reminders, and deletable on request.

ALTER TABLE registrations
    ADD COLUMN sms_number     VARCHAR(20),
    ADD COLUMN sms_opt_in_at  TIMESTAMPTZ;

COMMENT ON COLUMN registrations.sms_number IS
    'Recoverable phone number, stored ONLY for registrants who opted into SMS reminders. '
    'Every other identifier in this schema is an irreversible HMAC; this is the documented '
    'exception, disclosed in the privacy notice.';
COMMENT ON COLUMN registrations.sms_opt_in_at IS
    'When she agreed to SMS reminders. NULL means no opt-in and sms_number must be NULL.';

-- The number may exist only alongside a recorded opt-in.
ALTER TABLE registrations
    ADD CONSTRAINT chk_sms_optin_consistent CHECK (
        (sms_number IS NULL AND sms_opt_in_at IS NULL)
        OR
        (sms_number IS NOT NULL AND sms_opt_in_at IS NOT NULL)
    );

-- Down Migration
ALTER TABLE registrations
    DROP CONSTRAINT IF EXISTS chk_sms_optin_consistent,
    DROP COLUMN IF EXISTS sms_number,
    DROP COLUMN IF EXISTS sms_opt_in_at;
