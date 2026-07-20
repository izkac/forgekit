#!/usr/bin/env node
/**
 * Forge E2E acceptance — the closed product loop as an executable step list.
 *
 * Usage:
 *   forge e2e                         # show status (file, validity, results freshness)
 *   forge e2e init [--force]          # scaffold e2e.json for the active change
 *   forge e2e run                     # execute steps, write e2e-results.json (session dir)
 *   forge e2e check                   # gate check: green + current results; exit 1 with problems
 *   forge e2e harness                 # show recorded project harness (reuse it!)
 *   forge e2e harness --set "<desc>" [--start "<cmd>"] [--dir <path>]
 *   [--session <id>]
 *
 * e2e.json lives next to spine.json (change dir, falling back to the session
 * dir). Results carry a hash of the steps, so editing e2e.json after a green
 * run invalidates the results. `forge integrity-check` / `forge phase done`
 * run the same gate when the spine has real rows.
 */

import fs from 'node:fs';
import { loadSession, readActive, readJson } from './lib.mjs';
import { loadProjectConfig, saveProjectConfig } from './config.mjs';
import {
  checkE2eGate,
  e2ePath,
  e2eResultsPath,
  e2eStepsHash,
  initE2e,
  loadE2eResults,
  runE2eSteps,
  validateE2e,
  writeE2eResults,
} from './integrity.mjs';

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith('--') ? args[0] : 'status';

if (args[0] === '--help' || sub === 'help') {
  process.stdout.write(
    'Usage: forge e2e [init [--force] | run | check | status | harness [--set <desc> --start <cmd> --dir <path>]] [--session <id>]\n',
  );
  process.exit(0);
}

/** Recorded project harness (committed in .forge/config.json → e2e.harness). */
function loadHarness() {
  const cfg = loadProjectConfig(process.cwd());
  const h = cfg?.e2e?.harness;
  return h && typeof h === 'object' ? h : null;
}

function harnessLines(h) {
  const lines = [`Existing e2e harness (REUSE it — do not build or ask for a new one):`];
  lines.push(`  ${h.description}`);
  if (h.start) lines.push(`  Start: ${h.start}`);
  if (h.dir) lines.push(`  Location: ${h.dir}`);
  return lines.join('\n');
}

// Project-level, no session needed.
if (sub === 'harness') {
  const si = args.indexOf('--set');
  if (si >= 0) {
    const description = args[si + 1];
    if (!description || description.startsWith('--')) {
      process.stderr.write('Usage: forge e2e harness --set "<description>" [--start "<cmd>"] [--dir <path>]\n');
      process.exit(1);
    }
    const harness = { description, recordedAt: new Date().toISOString() };
    const st = args.indexOf('--start');
    if (st >= 0 && args[st + 1]) harness.start = args[st + 1];
    const di = args.indexOf('--dir');
    if (di >= 0 && args[di + 1]) harness.dir = args[di + 1];
    saveProjectConfig(process.cwd(), { e2e: { harness } }, { mergeKeys: ['adr', 'plan', 'e2e'] });
    process.stdout.write(
      `Recorded harness in .forge/config.json (commit it). Future sessions will see it on forge e2e init.\n`,
    );
    process.exit(0);
  }
  const h = loadHarness();
  if (!h) {
    process.stdout.write(
      'No harness recorded. After building one (with operator approval), record it:\n  forge e2e harness --set "<what/where>" --start "<command>" [--dir <path>]\n',
    );
    process.exit(0);
  }
  process.stdout.write(`${harnessLines(h)}\n`);
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
// archive). run/check/status read: allow the archive fallback.
const file = e2ePath({ session, sessionDir: dir, forWrite: sub === 'init' });

if (sub === 'init') {
  try {
    initE2e({ file, change: session.openspecChange ?? null, force });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Scaffolded ${file}\nAuthor the product-loop steps (produce → consume → assert domain side effects).\nSteps that would pass against a stubbed handler are invalid.\nRun with: forge e2e run\n`,
  );
  const harness = loadHarness();
  if (harness) process.stdout.write(`\n${harnessLines(harness)}\n`);
  process.exit(0);
}

if (sub === 'run') {
  if (!fs.existsSync(file)) {
    process.stderr.write(`e2e.json not found at ${file} — run forge e2e init\n`);
    process.exit(1);
  }
  let doc;
  try {
    doc = readJson(file);
  } catch (err) {
    process.stderr.write(`e2e.json unreadable: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  const valid = validateE2e(doc);
  if (!valid.ok) {
    process.stderr.write(`e2e.json invalid:\n${valid.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  if (typeof doc.notApplicable === 'string' && doc.notApplicable.trim()) {
    process.stdout.write(`e2e notApplicable: ${doc.notApplicable}\nNothing to run.\n`);
    process.exit(0);
  }
  const results = runE2eSteps(doc, { cwd: process.cwd() });
  const resultsFile = writeE2eResults(dir, results);
  for (const step of results.steps) {
    if (step.skipped) {
      process.stdout.write(`  - ${step.name}: skipped (earlier step failed)\n`);
    } else {
      process.stdout.write(
        `  ${step.ok ? '✓' : '✗'} ${step.name}: exit ${step.exitCode ?? 'n/a'}${
          step.expectMatched === false ? ' (expect did not match)' : ''
        }${step.error ? ` [${step.error}]` : ''} (${step.durationMs}ms)\n`,
      );
      if (!step.ok && step.outputTail) {
        process.stdout.write(`${step.outputTail.replace(/^/gm, '    ')}\n`);
      }
    }
  }
  process.stdout.write(`${results.ok ? 'GREEN' : 'FAILED'} — results: ${resultsFile}\n`);
  process.exit(results.ok ? 0 : 1);
}

if (sub === 'check') {
  const gate = checkE2eGate({ e2eFile: file, sessionDir: dir });
  process.stdout.write(
    JSON.stringify(
      { file, ok: gate.problems.length === 0, notApplicable: gate.notApplicable, problems: gate.problems },
      null,
      2,
    ),
  );
  process.stdout.write('\n');
  process.exit(gate.problems.length === 0 ? 0 : 1);
}

if (sub === 'status') {
  if (!fs.existsSync(file)) {
    process.stdout.write(JSON.stringify({ file, exists: false, harness: loadHarness() }, null, 2));
    process.stdout.write('\n');
    process.exit(0);
  }
  let doc = null;
  let valid = { ok: false, problems: ['unreadable'] };
  try {
    doc = readJson(file);
    valid = validateE2e(doc);
  } catch (err) {
    valid = { ok: false, problems: [`unreadable: ${err instanceof Error ? err.message : err}`] };
  }
  const results = loadE2eResults(dir);
  process.stdout.write(
    JSON.stringify(
      {
        file,
        exists: true,
        ok: valid.ok,
        problems: valid.problems,
        harness: loadHarness(),
        results: results
          ? {
              file: e2eResultsPath(dir),
              ok: results.ok === true,
              ranAt: results.ranAt ?? null,
              stale: doc ? results.stepsHash !== e2eStepsHash(doc.steps) : null,
            }
          : null,
      },
      null,
      2,
    ),
  );
  process.stdout.write('\n');
  process.exit(0);
}

process.stderr.write(`Unknown subcommand: ${sub}\n`);
process.exit(1);
