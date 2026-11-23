/**
 * Login IDs are free-form identifiers an admin hands out, e.g. "markandaproject@sppl".
 * They are stored in User.username. Because User.email is required + unique (and
 * a unique non-sparse index already exists in production), accounts created without a
 * real email get a deterministic placeholder email that is never used for sending mail.
 */

const LOGIN_ID_RE = /^[A-Za-z0-9._@-]{3,30}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const PLACEHOLDER_DOMAIN = '@noemail.local';

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidLoginId = (value) => LOGIN_ID_RE.test(String(value || '').trim());

const placeholderEmail = (loginId) =>
    `${String(loginId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '.')}${PLACEHOLDER_DOMAIN}`;

const isPlaceholderEmail = (email) => String(email || '').toLowerCase().endsWith(PLACEHOLDER_DOMAIN);

/** Case-insensitive exact match on username (login ID). */
const loginIdQuery = (loginId) => ({
    username: new RegExp(`^${escapeRegExp(String(loginId).trim())}$`, 'i'),
});

module.exports = {
    LOGIN_ID_RE,
    EMAIL_RE,
    isValidLoginId,
    placeholderEmail,
    isPlaceholderEmail,
    loginIdQuery,
    escapeRegExp,
};
