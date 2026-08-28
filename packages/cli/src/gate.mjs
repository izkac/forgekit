#!/usr/bin/env node
/**
 * Forge gate — opt-in per-group executable gates.
 *
 * Usage:
 *   forge gate init                   # scaffold gates.json from tasks.md groups
 *   forge gate check [--group <id>]   # execute group checks, write session results
 *   forge gate status [--json]        # met/unmet/stale/no-check/no-run per group
 *   [--session <id>]
 *
 * gates.json lives in the change dir (next to spine.json / e2e.json). Results
 * carry a hash of each group's check+expect, so editing a check after a green
 * run invalidates that group's evidence (`status` reports `stale`).
 *
 * Opt-in wall: without `.forge/config.json` → `gates.enabled === true`, every
 * subcommand prints one line and exits 1, writing nothing. A project that has
 * not opted in must pay zero cost for this feature — the wall is therefore
 * the very first thing checked, before argument parsing, session resolution,
 * or `--help`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSession, resolveSessionOrExit, readJson, writeJson } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';
import { resolveChangeDir, runE2eSteps } from './integrity.mjs';

const GATES_FILE = 'gates.json';
const GATE_RESULTS_FILE = 'gate-results.json';
const DEFAULT_TIMEOUT_MS = 60000;

/** Numbered task-group heading: `## 1. <title>` or `## 2) <title>`. */
const GROUP_HEADING_RE = /^##\s+(\d+)[.)]\s*(.*)$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Parse `tasks.md` `##` group headings into `{ id, title }` — id from the
 * leading number, title from the rest of the line.
 *
 * @param {string} body
 * @returns {{ id: string, title: string }[]}
 */
export function parseTaskGroups(body) {
  /** @type {{ id: string, title: string }[]} */
  const groups = [];
  for (const rawLine of String(body ?? '').split('\n')) {
    const m = GROUP_HEADING_RE.exec(rawLine.trim());
    if (m) groups.push({ id: m[1], title: m[2].trim() });
  }
  return groups;
}

/**
 * Hash of a group's check + expect — mirrors e2eStepsHash's approach (sha256
 * of the JSON-stringified fields that define what "passing" means) but
 * scoped to one group's check+expect rather than an ordered step array, so
 * editing a group's check after a green run invalidates only that group.
 *
 * @param {{ check?: string, expect?: string }} group
 */
export function groupChecksHash(group) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ check: group?.check ?? '', expect: group?.expect ?? '' }))
    .digest('hex');
}

/**
 * @param {string} sessionDir
 */
function gateResultsPath(sessionDir) {
  return path.join(sessionDir, GATE_RESULTS_FILE);
}

/**
 * @param {string} sessionDir
 * @returns {{ groups: Array<Record<string, unknown>>, ranAt: string | null } | null}
 */
function loadGateResults(sessionDir) {
  const file = gateResultsPath(sessionDir);
  if (!fs.existsSync(file)) return null;
  try {
    const doc = readJson(file);
    return { groups: Array.isArray(doc?.groups) ? doc.groups : [], ranAt: doc?.ranAt ?? null };
  } catch {
    return null;
  }
}

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string | null}
 */
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : null;
}

const args = process.argv.slice(2);

// Opt-in wall — see module doc: checked before anything else.
const projectConfig = loadProjectConfig(process.cwd());
if (projectConfig?.gates?.enabled !== true) {
  process.stderr.write('gates are not enabled (.forge/config.json → gates.enabled)\n');
  process.exit(1);
}

const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';

if (args[0] === '--help' || sub === 'help') {
  process.stdout.write('Usage: forge gate [init | check [--group <id>] | status [--json]] [--session <id>]\n');
  process.exit(0);
}

let sessionIdArg = null;
const groupIdArg = flagValue(args, '--group');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' && args[i + 1]) {
    sessionIdArg = args[i + 1];
    i += 1;
  }
}

const sessionId = resolveSessionOrExit(sessionIdArg, { command: 'forge gate', strict: false });
if (!sessionId) {
  process.stderr.write('No active session. Run forge new first.\n');
  process.exit(1);
}

const { dir, session } = loadSession(sessionId);
// init writes: target the live change dir only. check/status read: allow the
// archive fallback (resolveChangeDir handles both via forWrite).
const changeDir = resolveChangeDir({ session, cwd: process.cwd(), forWrite: sub === 'init' });
const file = changeDir ? path.join(changeDir, GATES_FILE) : path.join(dir, GATES_FILE);

if (sub === 'init') {
  if (fs.existsSync(file)) {
    process.stderr.write(`gates.json already exists: ${file}\nEdit it directly, or remove it to re-scaffold.\n`);
    process.exit(1);
  }
  if (!changeDir) {
    process.stderr.write(
      'No change directory to read tasks.md from — name a change first (forge phase plan), then retry.\n',
    );
    process.exit(1);
  }
  const tasksFile = path.join(changeDir, 'tasks.md');
  if (!fs.existsSync(tasksFile)) {
    process.stderr.write(`tasks.md not found at ${tasksFile} — nothing to scaffold gates from.\n`);
    process.exit(1);
  }
  const groups = parseTaskGroups(fs.readFileSync(tasksFile, 'utf8'));
  if (groups.length === 0) {
    process.stderr.write(`No "## <n>. <title>" group headings found in ${tasksFile}.\n`);
    process.exit(1);
  }
  writeJson(file, {
    groups: groups.map((g) => ({ id: g.id, title: g.title, check: '', expect: '', timeoutMs: DEFAULT_TIMEOUT_MS })),
  });
  process.stdout.write(
    `Scaffolded ${file}\n` +
      `Fill each group's check (executable command) and expect (regex); empty check = group has no gate yet.\n` +
      `Run with: forge gate check\n`,
  );
  process.exit(0);
}

if (sub === 'check') {
  if (!fs.existsSync(file)) {
    process.stderr.write(`gates.json not found at ${file} — run forge gate init\n`);
    process.exit(1);
  }
  let doc;
  try {
    doc = readJson(file);
  } catch (err) {
    process.stderr.write(`gates.json unreadable: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  const groups = Array.isArray(doc?.groups) ? doc.groups : [];
  let targets = groups;
  if (groupIdArg) {
    targets = groups.filter((g) => g.id === groupIdArg);
    if (targets.length === 0) {
      process.stderr.write(`Group not found in gates.json: ${groupIdArg}\n`);
      process.exit(1);
    }
  }
  const toRun = targets.filter((g) => isNonEmptyString(g.check));
  if (toRun.length === 0) {
    process.stdout.write('No groups have a check to run.\n');
    process.exit(0);
  }

  const existing = loadGateResults(dir);
  const resultsById = new Map((existing?.groups ?? []).map((r) => [r.id, r]));
  let allOk = true;

  for (const g of toRun) {
    // Reuse the e2e per-step runner as a single-step run — same step
    // semantics (exit 0 AND expect regex match), no reimplementation.
    const stepDoc = { steps: [{ name: g.title ?? g.id, cmd: g.check, expect: g.expect, timeoutMs: g.timeoutMs }] };
    const stepResult = runE2eSteps(stepDoc, { cwd: process.cwd() }).steps[0];
    const entry = {
      id: g.id,
      ok: stepResult.ok,
      exitCode: stepResult.exitCode,
      expectMatched: stepResult.expectMatched,
      durationMs: stepResult.durationMs,
      // Fingerprints (task 4.1): copied straight off the step result
      // runE2eSteps already computed — no extra spawn or hashing here.
      outputSha256: stepResult.outputSha256,
      cwd: stepResult.cwd,
      shell: stepResult.shell,
      checksHash: groupChecksHash(g),
    };
    resultsById.set(g.id, entry);
    if (!entry.ok) allOk = false;
    process.stdout.write(
      `  ${entry.ok ? '✓' : '✗'} ${g.id}: exit ${entry.exitCode ?? 'n/a'}${
        entry.expectMatched === false ? ' (expect did not match)' : ''
      } (${entry.durationMs}ms)\n`,
    );
  }

  // Keep only entries for groups gates.json still names, in gates.json order —
  // drops evidence for a group that has since been removed.
  const outGroups = groups.filter((g) => resultsById.has(g.id)).map((g) => resultsById.get(g.id));
  const results = { groups: outGroups, ranAt: new Date().toISOString() };
  const resultsFile = gateResultsPath(dir);
  writeJson(resultsFile, results);
  process.stdout.write(`${allOk ? 'GREEN' : 'FAILED'} — results: ${resultsFile}\n`);
  process.exit(allOk ? 0 : 1);
}

if (sub === 'status') {
  const asJson = args.includes('--json');
  if (!fs.existsSync(file)) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ file, exists: false, groups: [] }, null, 2)}\n`);
    } else {
      process.stdout.write(`gates.json not found at ${file} — run forge gate init\n`);
    }
    process.exit(0);
  }
  let doc = null;
  try {
    doc = readJson(file);
  } catch (err) {
    const message = `unreadable: ${err instanceof Error ? err.message : err}`;
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ file, exists: true, error: message, groups: [] }, null, 2)}\n`);
    } else {
      process.stdout.write(`gates.json ${message}\n`);
    }
    process.exit(0);
  }
  const groups = Array.isArray(doc?.groups) ? doc.groups : [];
  const results = loadGateResults(dir);
  const resultsById = new Map((results?.groups ?? []).map((r) => [r.id, r]));

  const rows = groups.map((g) => {
    let status;
    const recorded = resultsById.get(g.id);
    if (!isNonEmptyString(g.check)) {
      status = 'no-check';
    } else if (!recorded) {
      status = 'no-run';
    } else if (recorded.checksHash !== groupChecksHash(g)) {
      status = 'stale';
    } else if (recorded.ok === true) {
      status = 'met';
    } else {
      status = 'unmet';
    }
    return { id: g.id, title: g.title ?? '', status };
  });

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file,
          exists: true,
          resultsFile: gateResultsPath(dir),
          ranAt: results?.ranAt ?? null,
          groups: rows,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  if (rows.length === 0) {
    process.stdout.write('No groups in gates.json.\n');
    process.exit(0);
  }
  const lines = rows.map((r) => `  ${r.id.padEnd(4)}${r.status.padEnd(10)}${r.title}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

process.stderr.write(`Unknown subcommand: ${sub}\n`);
process.exit(1);
