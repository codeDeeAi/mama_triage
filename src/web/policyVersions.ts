/**
 * Policy versions.
 *
 * Bumped whenever the wording of the privacy notice or terms changes materially. The
 * version in force at registration is stored against the row, so a consent record always
 * identifies the text that was actually agreed to — a bare boolean would not survive the
 * first revision.
 */
export const PRIVACY_VERSION = 'privacy.v1';
export const TERMS_VERSION = 'terms.v1';
