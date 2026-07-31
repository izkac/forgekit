#!/usr/bin/env node
/**
 * `forge finding` — file, list and close findings (see findings.mjs).
 *
 * Usage:
 *   forge finding add "<text>" [--change <slug>] [--depends-on <ids>] --kind bug|debt|tradeoff|idea|process --severity blocker|major|minor|note
 *   forge finding link <id> --depends-on <ids>
 *   forge finding list [--json] [--all] [--all-kinds]
 *   forge finding resolve <id> [--note "<text>"]
 *   forge finding reopen <id> --from <oldId> --note "<text>"
 */

import { FORGE_DIR, loadSession, readActive } from './lib.mjs';
import { addFinding, linkFinding, readFindings, reopenFinding, resolveFinding } from './findings.mjs';

function usage() {
  process.stderr.write(
    `Usage:
  forge finding add "<text>" [--change <slug>] [--depends-on <ids>] --kind bug|debt|tradeoff|idea|process --severity blocker|major|minor|note
  forge finding link <id> --depends-on <ids>
  forge finding list [--json] [--all] [--all-kinds]
  forge finding resolve <id> [--note "<text>"]
  forge finding reopen <id> --from <oldId> --note "<text>"
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

function warnDependents(dependents) {
  if (dependents.length === 0) return;
  const rows = dependents.map((entry) => `${entry.id}  ${String(entry.text ?? '').split(/\r?\n/, 1)[0]}`);
  process.stderr.write(`Re-check these — their root cause just closed:\n${rows.join('\n')}\n`);
}

function parseDependencyIds(value) {
  if (typeof value !== 'string') fail('Dependencies need one or more finding ids.');
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => id === '')) fail('Dependency ids must not be empty.');
  return ids;
}

function reopenedFirst(entries) {
  return [...entries].sort((left, right) => {
    const leftReopened = left.reopenCount >= 1;
    const rightReopened = right.reopenCount >= 1;
    return Number(rightReopened) - Number(leftReopened);
  });
}

/** Soft-wrap `text` to `width`, prefixing every line with `indent`. */
function wrapIndented(text, { width, indent }) {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return indent.trimEnd() === '' ? '' : indent;
  const max = Math.max(width, indent.length + 8);
  const lines = [];
  let line = indent;
  for (const word of words) {
    const candidate = line === indent ? `${indent}${word}` : `${line} ${word}`;
    if (candidate.length > max && line !== indent) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = candidate;
    }
  }
  if (line.length > indent.length) lines.push(line);
  return lines.join('\n');
}

/**
 * One finding as a scannable block: meta on its own line, body indented and
 * soft-wrapped so a long paragraph does not run into the next id.
 */
function formatFindingBlock(entry, columns) {
  const id = String(entry.id).padEnd(4);
  const kind = String(entry.kind ?? 'unknown').padEnd(9);
  const severity = String(entry.severity ?? 'major').padEnd(7);
  let meta = `${id}  ${kind} ${severity}`.trimEnd();
  if (entry.reopenCount >= 1) meta += `  ↻${entry.reopenCount}`;
  if (entry.status !== 'open') meta += '  ✓';
  if (entry.change) meta += `  → ${entry.change}`;
  const wrapped = wrapIndented(entry.text, { width: columns, indent: '      ' });
  return wrapped ? `${meta}\n${wrapped}` : meta;
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
  let kind;
  let severity;
  let dependsOn;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--change' && argv[i + 1]) change = argv[(i += 1)];
    else if (argv[i] === '--kind' && argv[i + 1]) kind = argv[(i += 1)];
    else if (argv[i] === '--severity' && argv[i + 1]) severity = argv[(i += 1)];
    else if (argv[i] === '--depends-on') dependsOn = parseDependencyIds(argv[(i += 1)]);
    else fail(`Unknown argument: ${argv[i]}`);
  }
  try {
    const entry = addFinding({
      forgeDir: FORGE_DIR,
      text,
      kind,
      severity,
      change,
      dependsOn,
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

if (cmd === 'link') {
  const id = argv[1];
  if (!id) fail('Usage: forge finding link <id> --depends-on <ids>');
  let dependsOn;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--depends-on') dependsOn = parseDependencyIds(argv[(i += 1)]);
    else fail(`Unknown argument: ${argv[i]}`);
  }
  if (!dependsOn) fail('Usage: forge finding link <id> --depends-on <ids>');
  try {
    emit({ ok: true, ...linkFinding({ forgeDir: FORGE_DIR, id, dependsOn }) });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

if (cmd === 'list') {
  const all = argv.includes('--all');
  const allKinds = argv.includes('--all-kinds');
  const entries = readFindings(FORGE_DIR);
  const open = entries.filter((e) => e.status === 'open');
  const resolved = entries.filter((e) => e.status !== 'open');
  const visibleOpen = reopenedFirst(allKinds ? open : open.filter((e) => e.kind === 'bug'));
  const visibleResolved = allKinds ? resolved : resolved.filter((e) => e.kind === 'bug');
  const hiddenOpenNonBugs = allKinds ? 0 : open.length - visibleOpen.length;
  if (argv.includes('--json')) {
    emit({
      open: visibleOpen,
      resolved: all ? visibleResolved : visibleResolved.slice(-10),
      total: entries.length,
    });
    process.exit(0);
  }
  if (entries.length === 0) {
    process.stdout.write('No findings recorded. File one: forge finding add "<text>"\n');
    process.exit(0);
  }
  const columns = process.stdout.columns || 80;
  const rows = (all ? [...visibleOpen, ...visibleResolved] : visibleOpen).map((e) =>
    formatFindingBlock(e, columns),
  );
  process.stdout.write(
    `${rows.join('\n\n')}${rows.length ? '\n\n' : ''}${visibleOpen.length} open, ${visibleResolved.length} resolved${
      all ? '' : ' (--all to see resolved)'
    }${hiddenOpenNonBugs ? `; ${hiddenOpenNonBugs} open non-bug findings hidden (--all-kinds to see them)` : ''}\n`,
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
    const { entry, dependents } = resolveFinding({ forgeDir: FORGE_DIR, id, note });
    emit({ ok: true, ...entry, dependents });
    warnDependents(dependents);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

if (cmd === 'reopen') {
  const id = argv[1];
  if (!id) fail('Usage: forge finding reopen <id> --from <oldId> --note "<text>"');
  let from;
  let note;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--from' && argv[i + 1]) from = argv[(i += 1)];
    else if (argv[i] === '--note' && argv[i + 1]) note = argv[(i += 1)];
    else fail(`Unknown argument: ${argv[i]}`);
  }
  if (!from || !note) fail('Usage: forge finding reopen <id> --from <oldId> --note "<text>"');
  try {
    emit({ ok: true, ...reopenFinding({ forgeDir: FORGE_DIR, id, from, note }) });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

usage();
fail(`Unknown subcommand: ${cmd}`);
