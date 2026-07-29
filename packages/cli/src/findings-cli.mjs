#!/usr/bin/env node
/**
 * `forge finding` — file, list and close findings (see findings.mjs).
 *
 * Usage:
 *   forge finding add "<text>" [--change <slug>] [--severity blocker|major|minor|note]
 *   forge finding list [--json] [--all]
 *   forge finding resolve <id> [--note "<text>"]
 */

import { FORGE_DIR, loadSession, readActive } from './lib.mjs';
import { addFinding, readFindings, resolveFinding } from './findings.mjs';

function usage() {
  process.stderr.write(
    `Usage:
  forge finding add "<text>" [--change <slug>] [--severity blocker|major|minor|note]
  forge finding list [--json] [--all]
  forge finding resolve <id> [--note "<text>"]
`,
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Active session, or nulls — findings are often filed between sessions.
 *
 * Stays on the pointer deliberately: this only *annotates* a finding with
 * whichever session is around, and must tolerate there being none. Resolving
 * through `resolveSessionOrExit` would make `forge finding add` exit when two
 * sessions are open, which is when you most want to write one down.
 */
function activeSessionInfo() {
  try {
    const active = readActive();
    if (!active?.sessionId) return { sessionId: null, slug: null };
    const { session } = loadSession(active.sessionId);
    return { sessionId: session.id ?? null, slug: session.slug ?? null };
  } catch {
    return { sessionId: null, slug: null };
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(cmd ? 0 : 1);
}

if (cmd === 'add') {
  const text = argv[1] ?? '';
  if (!text.trim() || text.startsWith('--')) {
    fail('A finding needs text: forge finding add "<text>"');
  }
  let change = null;
  let severity = 'major';
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--change' && argv[i + 1]) change = argv[(i += 1)];
    else if (argv[i] === '--severity' && argv[i + 1]) severity = argv[(i += 1)];
    else fail(`Unknown argument: ${argv[i]}`);
  }
  try {
    const entry = addFinding({
      forgeDir: FORGE_DIR,
      text,
      severity,
      change,
      session: activeSessionInfo(),
    });
    emit({
      ok: true,
      ...entry,
      next: change
        ? `Open its home: forge change new ${change}`
        : 'Give it a home: forge change new <slug>, forge defer add, or fix it now — otherwise label it a note (--severity note).',
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

if (cmd === 'list') {
  const all = argv.includes('--all');
  const entries = readFindings(FORGE_DIR);
  const open = entries.filter((e) => e.status === 'open');
  const resolved = entries.filter((e) => e.status !== 'open');
  if (argv.includes('--json')) {
    emit({ open, resolved: all ? resolved : resolved.slice(-10), total: entries.length });
    process.exit(0);
  }
  if (entries.length === 0) {
    process.stdout.write('No findings recorded. File one: forge finding add "<text>"\n');
    process.exit(0);
  }
  const rows = (all ? entries : open).map(
    (e) =>
      `${e.id}  ${String(e.severity ?? 'major').padEnd(7)} ${e.status === 'open' ? ' ' : '✓'} ${e.text}${
        e.change ? `  → ${e.change}` : ''
      }`,
  );
  process.stdout.write(
    `${rows.join('\n')}\n\n${open.length} open, ${resolved.length} resolved${
      all ? '' : ' (--all to see resolved)'
    }\n`,
  );
  process.exit(0);
}

if (cmd === 'resolve') {
  const id = argv[1];
  if (!id) fail('Usage: forge finding resolve <id> [--note "<text>"]');
  let note = null;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--note' && argv[i + 1]) note = argv[(i += 1)];
    else fail(`Unknown argument: ${argv[i]}`);
  }
  try {
    emit({ ok: true, ...resolveFinding({ forgeDir: FORGE_DIR, id, note }) });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

usage();
fail(`Unknown subcommand: ${cmd}`);
