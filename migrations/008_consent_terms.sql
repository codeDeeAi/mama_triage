-- Up Migration
-- Record WHAT she agreed to, not merely that she agreed.
--
-- "consented" as a bare boolean is not defensible: the notice will be revised, and a
-- consent given against version 1 is not consent to version 2. Storing the version means
-- the record can be reconstructed, which is what the Nigeria Data Protection Act 2023
-- expects of a lawful basis and what an ethics reviewer will ask for.

ALTER TABLE registrations
    ADD COLUMN terms_version   VARCHAR(20),
    ADD COLUMN privacy_version VARCHAR(20);

COMMENT ON COLUMN registrations.terms_version IS
    'Version of the terms of use accepted at registration, e.g. terms.v1';
COMMENT ON COLUMN registrations.privacy_version IS
    'Version of the privacy notice accepted at registration, e.g. privacy.v1';

-- Down Migration
ALTER TABLE registrations
    DROP COLUMN IF EXISTS terms_version,
    DROP COLUMN IF EXISTS privacy_version;
