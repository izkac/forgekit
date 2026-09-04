#!/usr/bin/env node
/**
 * `forge review-precheck [--session <id>] [--json]`
 *
 * Prints the machine-verified facts block a reviewer packet carries in place
 * of the reviewer re-running tests, forge checks and ledger inspection.
 * Exits 1 when integrity problems exist and the session is past implement —
 * fix those before paying for a reviewer that `forge phase done` would refuse
 * anyway. During implement the product-loop gates are not expected to be
 * green yet, so problems print but do not fail the command.
 */

import { loadSession, resolveSessionOrExit } from './lib.mjs';
import { collectPrecheck, renderPrecheck } from './review-precheck.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  process.stdout.write('Usage: forge review-precheck [--session <id>] [--json]\n');
  process.exit(0);
}

let sessionId = null;
let json = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  } else if (args[i] === '--json') {
    json = true;
  } else {
    process.stderr.write(`Unknown option: ${args[i]}\nUsage: forge review-precheck [--session <id>] [--json]\n`);
    process.exit(1);
  }
}

sessionId = resolveSessionOrExit(sessionId, { command: 'forge review-precheck', strict: false });
if (!sessionId) {
  process.stderr.write('No active session. Run forge new first.\n');
  process.exit(1);
}

const { dir, session } = loadSession(sessionId);
const result = collectPrecheck({ sessionDir: dir, session });
process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderPrecheck(result));
// During implement the e2e/spine gates cannot be green yet (verify produces
// them), so problems are informational for a group reviewer; from verify on
// they are the same refusal `forge phase done` would give.
const tailPhase = ['verify', 'review', 'finish', 'done'].includes(String(session.phase));
process.exit(tailPhase && result.integrity && !result.integrity.ok ? 1 : 0);
