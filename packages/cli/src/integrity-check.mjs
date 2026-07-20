#!/usr/bin/env node
/**
 * Forge integrity check — mechanical gate behind `forge phase done|finish`.
 *
 * Usage:
 *   forge integrity-check [--session <id>]
 *
 * Fails (exit 1) when:
 *   - deferrals are unresolved
 *   - spine.json is missing or invalid
 *   - a spine with rows exists but the executable E2E acceptance is missing,
 *     failed, or stale (e2e.json + green, current e2e-results.json), or
 *     verify-evidence.md contains an explicit BLOCKED marker
 */

import { loadSession, readActive } from './lib.mjs';
import { runIntegrityChecks } from './integrity.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help') {
  process.stdout.write('Usage: forge integrity-check [--session <id>]\n');
  process.exit(0);
}

let sessionId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
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
const result = runIntegrityChecks({ sessionDir: dir, session });

process.stdout.write(
  JSON.stringify(
    {
      sessionId,
      ok: result.ok,
      problems: result.problems,
      spineFile: result.spineFile,
      spineExists: result.spineExists,
      e2eFile: result.e2eFile,
    },
    null,
    2,
  ),
);
process.stdout.write('\n');
process.exit(result.ok ? 0 : 1);
