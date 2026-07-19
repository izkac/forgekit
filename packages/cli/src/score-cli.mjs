#!/usr/bin/env node
/**
 * Score the active Forge session (L2 scorecard).
 *
 * Usage:
 *   forge score [--session <id>] [--write] [--json]
 *
 * Without --write: print JSON to stdout.
 * With --write: also write scorecard.json + scorecard.md into the session dir.
 */

import { loadSession, readActive } from './lib.mjs';
import { formatScorecardMarkdown, scoreSession, writeSessionScorecard } from './score.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help') {
  process.stdout.write(
    'Usage: forge score [--session <id>] [--write] [--json]\n' +
      '  Scores session artifacts (spine, deferrals, product-loop, evidence, pace).\n' +
      '  --write  save scorecard.json + scorecard.md into the session dir\n' +
      '  --json   print JSON (default); omit for markdown summary on stdout\n',
  );
  process.exit(0);
}

let sessionId = null;
let write = false;
let asJson = true;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  } else if (args[i] === '--write') {
    write = true;
  } else if (args[i] === '--markdown' || args[i] === '--md') {
    asJson = false;
  } else if (args[i] === '--json') {
    asJson = true;
  }
}

if (!sessionId) {
  const active = readActive();
  sessionId = active?.sessionId;
}
if (!sessionId) {
  process.stderr.write('No active session. Run forge new first.\n');
  process.exit(1);
}

const { dir, session } = loadSession(sessionId);
const result = write
  ? writeSessionScorecard({ sessionDir: dir, session })
  : { card: scoreSession({ sessionDir: dir, session }), jsonPath: null, mdPath: null };

const { card } = result;
if (asJson) {
  process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
} else {
  process.stdout.write(formatScorecardMarkdown(card));
}

if (write && result.mdPath) {
  process.stderr.write(`Wrote ${result.mdPath}\n`);
}

// Non-zero if grade is D/F — useful in CI / finish hooks
process.exit(card.grade === 'D' || card.grade === 'F' ? 1 : 0);
