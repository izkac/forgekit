#!/usr/bin/env node
/**
 * Forge deferral registry — deferred wiring is tracked debt, not a checkbox.
 *
 * Usage:
 *   forge defer add --task <id> --reason "<why deferred>"
 *   forge defer resolve --task <id>
 *   forge defer list
 *   [--session <id>]
 *
 * Unresolved deferrals block `forge phase done|finish`.
 */

import { loadSession, readActive } from './lib.mjs';
import { addDeferral, loadDeferrals, resolveDeferral } from './integrity.mjs';

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'list';

if (args[0] === '--help' || sub === 'help') {
  process.stdout.write(
    'Usage: forge defer [add --task <id> --reason "<why>" | resolve --task <id> | list] [--session <id>]\n',
  );
  process.exit(0);
}

let sessionId = null;
let task = null;
let reason = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[i + 1];
    i += 1;
  } else if (args[i] === '--task' && args[i + 1]) {
    task = args[i + 1];
    i += 1;
  } else if (args[i] === '--reason' && args[i + 1]) {
    reason = args[i + 1];
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

const { dir } = loadSession(sessionId);

try {
  if (sub === 'add') {
    const doc = addDeferral(dir, { task: task ?? '', reason: reason ?? '' });
    process.stdout.write(JSON.stringify(doc, null, 2));
    process.stdout.write('\n');
  } else if (sub === 'resolve') {
    if (!task) throw new Error('resolve requires --task <id>');
    const doc = resolveDeferral(dir, task);
    process.stdout.write(JSON.stringify(doc, null, 2));
    process.stdout.write('\n');
  } else if (sub === 'list') {
    const doc = loadDeferrals(dir);
    const open = doc.deferrals.filter((d) => !d.resolvedAt).length;
    process.stdout.write(JSON.stringify({ open, ...doc }, null, 2));
    process.stdout.write('\n');
  } else {
    throw new Error(`Unknown subcommand: ${sub}`);
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
