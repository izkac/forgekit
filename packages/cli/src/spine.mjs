#!/usr/bin/env node
/**
 * Forge spine matrix — scaffold + validate the capability→runtime wiring map.
 *
 * Usage:
 *   forge spine                       # show status (path, validity)
 *   forge spine init [--force]        # scaffold spine.json for the active change
 *   forge spine check                 # validate; exit 1 with problems
 *   [--session <id>]
 *
 * spine.json lives in the change dir (openspec/changes/<name>/ or
 * <specsDir>/changes/<name>/), falling back to the session dir when the
 * session has no tracked change.
 */

import fs from 'node:fs';
import { loadSession, readActive, readJson } from './lib.mjs';
import { initSpine, spinePath, validateSpine } from './integrity.mjs';

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';

if (args[0] === '--help' || sub === 'help') {
  process.stdout.write(
    'Usage: forge spine [init [--force] | check | status] [--session <id>]\n',
  );
  process.exit(0);
}

let sessionId = null;
let force = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  } else if (args[i] === '--force') {
    force = true;
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
// init writes: target the live change dir only (never fall back into the
// archive). check/status read: allow the archive fallback.
const file = spinePath({ session, sessionDir: dir, forWrite: sub === 'init' });

if (sub === 'init') {
  try {
    initSpine({ file, change: session.openspecChange ?? null, force });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Scaffolded ${file}\nFill every row (one per capability/REQ cluster); reads/uiConsumer may be "N/A".\nValidate with: forge spine check\n`,
  );
  process.exit(0);
}

if (sub === 'check' || sub === 'status') {
  if (!fs.existsSync(file)) {
    const msg = `spine.json not found at ${file} — run forge spine init\n`;
    if (sub === 'check') {
      process.stderr.write(msg);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ file, exists: false }, null, 2));
    process.stdout.write('\n');
    process.exit(0);
  }
  let result;
  try {
    result = validateSpine(readJson(file));
  } catch (err) {
    result = { ok: false, problems: [`unreadable: ${err instanceof Error ? err.message : err}`] };
  }
  process.stdout.write(
    JSON.stringify({ file, exists: true, ok: result.ok, problems: result.problems }, null, 2),
  );
  process.stdout.write('\n');
  process.exit(sub === 'check' && !result.ok ? 1 : 0);
}

process.stderr.write(`Unknown subcommand: ${sub}\n`);
process.exit(1);
