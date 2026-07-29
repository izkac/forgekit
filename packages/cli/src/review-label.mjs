/**
 * The exact dispatch description a reviewer subagent must carry:
 * `forge-review <unit> <forge-session-id>`.
 *
 * Pure on purpose. The CLI that reads the session and prints this lives in
 * `review-label-cli.mjs`, because the first version put both in one file and
 * running the CLI body on import killed this module's own test suite on any
 * checkout without a `.forge/active.json` — which is gitignored, so every clean
 * one. A module whose tests only pass on the author's machine is not tested.
 */


/** The unit charset `metrics/review-evidence.mjs` matches; kept in step by test. */
const UNIT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The prescribed description for a review unit in a given session.
 *
 * @param {string} unit
 * @param {string} sessionId
 * @returns {string}
 */
export function reviewLabel(unit, sessionId) {
  return `forge-review ${unit.toLowerCase()} ${sessionId}`;
}

/**
 * Is `unit` a review unit the matcher can read back?
 *
 * @param {string} unit
 * @returns {boolean}
 */
export function isReviewUnit(unit) {
  return typeof unit === 'string' && UNIT.test(unit);
}
