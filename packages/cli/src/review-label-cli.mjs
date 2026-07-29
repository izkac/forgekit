#!/usr/bin/env node
/**
 * `forge review-label [<unit>] [--session <id>]` — print the exact Task-tool
 * description a reviewer must be dispatched with.
 *
 * WHY THIS IS A COMMAND AND NOT A SENTENCE IN THE DOCS. The description is the
 * join between a review artifact and the host's own record of the subagent that
 * produced it, and it decides the money/auth `forge phase done` gate. It has to
 * be exact, and it carries the Forge session id, which nobody should be
 * retyping from a directory listing.
 *
 * The measured failure it exists to prevent: almost no real dispatch record
 * carries the label, and of those that do, almost none carries the session id
 * the matcher needs. A convention that has to be transcribed by hand is a
 * convention that is not adopted. The current count is in `review-census.mjs`'s
 * adoption-gate note, which is the one place it is kept.
 *
 * The CLI lives apart from `review-label.mjs` so that importing `reviewLabel`
 * does not run it — the first version put both in one file, and its own test
 * suite died on any checkout without a `.forge/active.json` (which is
 * gitignored, so: every clean one).
 */

import { loadSession, resolveSessionId, sessionAmbiguityMessage } from './lib.mjs';
import { isReviewUnit, reviewLabel } from './review-label.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(
    'Usage: forge review-label [<unit>] [--session <id>]\n\n' +
      'Prints the exact Task-tool description a reviewer must be dispatched with.\n' +
      'Defaults to the final review — the only unit that decides the gate.\n' +
      'Pass --session when driving a session other than the active one.\n',
  );
  process.exit(0);
}

let sessionId = null;
/** @type {string | null} */
let unit = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  } else if (args[i].startsWith('-')) {
    // NOT ignored. An unknown flag used to fall through and leave `unit` at its
    // default, so asking for a group label with a typo printed the *final*
    // one — the single label that decides the money/auth gate — and the
    // coordinator would have dispatched a group reviewer carrying it.
    process.stderr.write(
      `Unknown option: ${args[i]}\nUsage: forge review-label [<unit>] [--session <id>]\n`,
    );
    process.exit(1);
  } else if (unit !== null) {
    process.stderr.write(
      `Expected one review unit, got ${JSON.stringify(unit)} and ${JSON.stringify(args[i])}.\n`,
    );
    process.exit(1);
  } else {
    unit = args[i];
  }
}

unit ??= 'final';
if (!isReviewUnit(unit)) {
  process.stderr.write(
    `Not a usable review unit: ${JSON.stringify(unit)}\n` +
      'Units are letters, digits, dot, dash and underscore — e.g. final, group-03.\n',
  );
  process.exit(1);
}

// THE LABEL IS GATE-CLASS, so it refuses on ambiguity rather than warning.
// `forge phase implement` guessing wrong costs a re-run; this string decides
// which change is credited with the reviewer, and a wrong one passes that
// change's money/auth floor on a reviewer that never read it — permanently, in
// the durable ledger. Same reason `forge phase done` and `finish` refuse.
const resolved0 = resolveSessionId(sessionId);
if (resolved0.id === null || resolved0.ambiguous) {
  process.stderr.write(
    resolved0.problem || resolved0.ambiguous
      ? sessionAmbiguityMessage(resolved0, 'forge review-label final')
      : 'No active session. Run forge new first.\n',
  );
  process.exit(1);
}
sessionId = resolved0.id;
const resolvedFrom = resolved0.from;

// Resolve through the session so a stale `active.json` fails here, loudly,
// rather than producing a label that silently matches nothing at the gate.
let resolved;
try {
  resolved = loadSession(sessionId).session;
} catch (err) {
  process.stderr.write(
    `Could not read session ${sessionId}: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
}

const id = resolved.id ?? sessionId;
// ALWAYS NAME THE SESSION BEING LABELLED. The label decides which session gets
// credited with the reviewer, and the failure it guards against is silent: a
// coordinator driving one session while `active.json` names another dispatches
// under the neighbour's id, and the neighbour passes the money/auth floor on a
// reviewer that read someone else's change. On stderr so it cannot pollute the
// label on stdout.
process.stderr.write(
  `[forge] labelling session ${id}${resolved.slug ? ` (${resolved.slug})` : ''}` +
    `${
      resolvedFrom === 'active'
        ? ' — from .forge/active.json; pass --session to label another'
        : resolvedFrom === 'only-open'
          ? ' — the only session still open here; pass --session to label another'
          : ''
    }\n`,
);
process.stdout.write(`${reviewLabel(unit, id)}\n`);
