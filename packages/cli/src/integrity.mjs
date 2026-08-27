/**
 * Forge runtime-integrity mechanics: spine matrix, deferral registry,
 * executable E2E acceptance, and the integrity checks that gate
 * `forge phase done|finish`.
 *
 * Spine matrix — `spine.json` in the change dir (or session dir when the
 * session has no tracked change). One row per capability/REQ cluster:
 * library → runtime owner → writes → reads → UI consumer → evidence.
 * Library-only rows (missing runtime owner / writes / evidence) fail
 * validation, so "wire later" cannot be checkboxed past `forge phase done`.
 *
 * E2E acceptance — `e2e.json` next to the spine: the closed product loop as
 * an executable step list. `forge e2e run` executes it and records
 * `e2e-results.json` (session dir) with a hash of the steps, so results go
 * stale when steps change. When the spine has real rows, the gate requires a
 * green, current run — prose in verify-evidence.md no longer satisfies it.
 *
 * Deferral registry — `deferrals.json` in the session dir. Reviewers may only
 * accept "wiring deferred" when a registered deferral names the open task;
 * unresolved deferrals block done/finish.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasBlockedMarker, readJson, writeJson } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';
import { DEFAULT_SPECS_DIR, resolveProjectPlanEngine } from './plan-engine.mjs';
import { classifyGuarded, findAllowance, loadAllowances, makeGitLsTree } from './guard.mjs';
import { NO_TDD_MARKER, NO_TDD_REASON_LABEL } from './record-evidence.mjs';

/** Signals that a change involves jobs/workers and therefore needs a spine. */
export const JOBS_SIGNAL_RE =
  /\b(worker|workers|job|jobs|queue|queues|pipeline|pipelines|etl|orchestration|handler|handlers|cron|scheduler|daemon|ingest|dispatch)\b/i;

/** Row fields that must be filled (reads/uiConsumer accept "N/A"). */
export const SPINE_ROW_REQUIRED = Object.freeze([
  'capability',
  'library',
  'runtimeOwner',
  'writes',
  'reads',
  'uiConsumer',
  'evidence',
]);

const SPINE_FILE = 'spine.json';
const DEFERRALS_FILE = 'deferrals.json';

/**
 * @param {unknown} value
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolve the change directory for a session (openspec or specs engine).
 * Returns null when the session has no tracked change.
 *
 * @param {{ cwd?: string, session?: Record<string, unknown> | null }} opts
 */
/**
 * The archived copy of a change, when the live dir is gone. Archiving moves
 * `changes/<change>/` to `changes/archive/<YYYY-MM-DD>-<change>/`.
 *
 * The done-gate in set-phase.mjs now enforces this ordering: it refuses
 * `done`/`finish` while the change dir is still live, so by the time this
 * integrity check runs at done, an archived change is the normal case rather
 * than a possibility to tolerate. This fallback nevertheless stays
 * deliberately permissive and must not grow an archive check of its own —
 * `runIntegrityChecks` is also called by `forge integrity-check` and
 * `forge score` at any phase, where an unarchived change is correct and
 * expected. That is why the gate lives in the done-gate instead of here.
 * Returns null if no match.
 *
 * @param {string} changesDir absolute path to `<root>/changes`
 * @param {string} change change name
 */
function findArchivedChangeDir(changesDir, change) {
  const archiveDir = path.join(changesDir, 'archive');
  if (!fs.existsSync(archiveDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // CLI + documented manual archive both name dirs `YYYY-MM-DD-<change>`;
    // slice(11) drops the `YYYY-MM-DD-` prefix so the suffix must equal the
    // change exactly (no false match on `…-other-<change>`).
    .filter((name) => name === change || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === change))
    .sort();
  // Date-prefixed names sort lexically by date — newest archive wins.
  return matches.length ? path.join(archiveDir, matches[matches.length - 1]) : null;
}

/** Live change dir if present, else its archived copy, else the live path. */
function liveOrArchived(changesDir, change) {
  const liveDir = path.join(changesDir, change);
  if (fs.existsSync(liveDir)) return liveDir;
  return findArchivedChangeDir(changesDir, change) ?? liveDir;
}

export function resolveChangeDir(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const session = opts.session ?? null;
  // Write callers (spine/e2e init) must always target the LIVE change dir —
  // scaffolding into an archived record would corrupt frozen history. Only
  // read callers (checks, gates) fall back to the archive.
  const forWrite = opts.forWrite === true;
  const change = session && isNonEmptyString(session.openspecChange) ? session.openspecChange : null;
  if (!change) return null;

  const openspecChanges = path.join(cwd, 'openspec', 'changes');
  const openspecDir = path.join(openspecChanges, change);
  if (session.planType === 'openspec') {
    return forWrite ? openspecDir : liveOrArchived(openspecChanges, change);
  }

  // Only a *specs* engine resolution can name the specs dir. The engine
  // resolver's last resort is {engine:'openspec', dir:'openspec'}, so taking
  // `.dir` unconditionally pointed specs sessions at `openspec/changes/<name>`
  // in every project whose .forge/config.json has no `plan` block — the change
  // dir, its brief.html, spine.json and e2e.json all silently missing.
  let specsRoot = DEFAULT_SPECS_DIR;
  try {
    const engine = resolveProjectPlanEngine(cwd, { useUserDefault: false });
    if (engine.engine === 'specs') specsRoot = engine.dir;
  } catch {
    // keep default
  }
  const specsChanges = path.join(cwd, specsRoot, 'changes');
  const specsDir = path.join(specsChanges, change);
  if (session.planType === 'specs') {
    return forWrite ? specsDir : liveOrArchived(specsChanges, change);
  }

  // planType unknown — prefer whichever exists (live first, then archived)
  if (fs.existsSync(openspecDir)) return openspecDir;
  if (fs.existsSync(specsDir)) return specsDir;
  if (forWrite) return openspecDir;
  return (
    findArchivedChangeDir(openspecChanges, change) ??
    findArchivedChangeDir(specsChanges, change) ??
    openspecDir
  );
}

/**
 * Path to spine.json: change dir when available, else session dir.
 *
 * @param {{ cwd?: string, session?: Record<string, unknown> | null, sessionDir?: string }} opts
 */
/** Stray files already reported, so a multi-check command says it once. */
const warnedStrays = new Set();

/**
 * A reader's answer to "where is this artefact?", which is not always the
 * canonical path.
 *
 * `spine.json` and `e2e.json` belong in the change dir, but `forge spine init` /
 * `forge e2e init` can only put them there once the session **names** a change.
 * Scaffold first and set the phase second — which is the order
 * `plan-specs.md` itself documents, spine/e2e at step 4 and `forge phase plan`
 * at step 6 — and they land in the session dir instead. The session then gains
 * its change, the canonical path starts resolving, and `forge e2e run` reports
 * "e2e.json not found — run forge e2e init" about the one command that just
 * succeeded. That is F50.
 *
 * Readers therefore prefer a file that exists over a path that is merely
 * correct. `forWrite` callers never take this branch: scaffolding must always
 * target the canonical location, or the stray copy becomes the permanent one.
 *
 * NOT SILENT, or the file stays lost. The canonical path is where a reviewer,
 * `forge change archive` and everything reading the change dir will look, so a
 * fallback that says nothing trades one confusion for a quieter one.
 *
 * @param {string} canonical the change-dir path
 * @param {{ sessionDir?: string, forWrite?: boolean }} opts
 * @param {string} file basename to look for in the session dir
 */
function strayFallback(canonical, opts, file) {
  if (opts.forWrite === true || fs.existsSync(canonical) || !opts.sessionDir) return canonical;
  const stray = path.join(opts.sessionDir, file);
  if (!fs.existsSync(stray)) return canonical;
  if (!warnedStrays.has(stray)) {
    warnedStrays.add(stray);
    process.stderr.write(
      `[forge] Reading ${file} from the session dir: ${stray}\n` +
        `  It belongs beside the change, at ${canonical} — scaffolded before this session named ` +
        `a change (F50).\n  Move it there so reviewers and \`forge change archive\` can see it.\n`,
    );
  }
  return stray;
}

export function spinePath(opts = {}) {
  const changeDir = resolveChangeDir(opts);
  if (changeDir) return strayFallback(path.join(changeDir, SPINE_FILE), opts, SPINE_FILE);
  if (opts.sessionDir) return path.join(opts.sessionDir, SPINE_FILE);
  throw new Error('Cannot resolve spine.json location: no change and no session dir');
}

/**
 * @param {{ change?: string | null }} [opts]
 */
export function spineTemplate(opts = {}) {
  return {
    change: opts.change ?? null,
    notApplicable: null,
    rows: [
      {
        capability: '<REQ id or capability cluster, e.g. REQ-GOV-01 matching>',
        library: '<module path, e.g. services/etl-core/matcher.py>',
        runtimeOwner: '<production caller, e.g. worker job analyze_study>',
        writes: '<artifact/collection, e.g. study_proposals>',
        reads: '<consumed inputs, or N/A>',
        uiConsumer: '<UI/API surface reading the writes, or N/A>',
        evidence: '<tier-2/E2E evidence path proving the wired path>',
      },
    ],
  };
}

/**
 * Scaffold spine.json (refuses to overwrite unless force).
 *
 * @param {{ file: string, change?: string | null, force?: boolean }} opts
 */
export function initSpine(opts) {
  if (fs.existsSync(opts.file) && !opts.force) {
    throw new Error(`spine.json already exists: ${opts.file} (use --force to overwrite)`);
  }
  writeJson(opts.file, spineTemplate({ change: opts.change }));
  return opts.file;
}

/**
 * Validate a spine document.
 *
 * Valid when either:
 *  - `notApplicable` is a non-empty string (honest opt-out, e.g. docs-only), or
 *  - `rows` is a non-empty array where every required cell is filled and no
 *    cell still contains scaffold placeholders (`<...>`).
 *
 * @param {unknown} doc
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateSpine(doc) {
  /** @type {string[]} */
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, problems: ['spine.json is not an object'] };
  }
  const spine = /** @type {Record<string, unknown>} */ (doc);

  if (isNonEmptyString(spine.notApplicable)) {
    return { ok: true, problems: [] };
  }

  const rows = spine.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      problems: ['spine.rows is empty — add one row per capability, or set notApplicable with a reason'],
    };
  }

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`row ${i + 1}: not an object`);
      return;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    for (const field of SPINE_ROW_REQUIRED) {
      const value = r[field];
      if (!isNonEmptyString(value)) {
        problems.push(`row ${i + 1} (${r.capability ?? '?'}): missing ${field}`);
      } else if (/^<.*>$/.test(value.trim())) {
        problems.push(`row ${i + 1} (${r.capability ?? '?'}): ${field} still has scaffold placeholder`);
      }
    }
  });

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/* E2E acceptance — executable product loop                            */
/* ------------------------------------------------------------------ */

const E2E_FILE = 'e2e.json';
const E2E_RESULTS_FILE = 'e2e-results.json';
export const E2E_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Path to e2e.json: change dir when available, else session dir.
 *
 * @param {{ cwd?: string, session?: Record<string, unknown> | null, sessionDir?: string }} opts
 */
export function e2ePath(opts = {}) {
  const changeDir = resolveChangeDir(opts);
  if (changeDir) return strayFallback(path.join(changeDir, E2E_FILE), opts, E2E_FILE);
  if (opts.sessionDir) return path.join(opts.sessionDir, E2E_FILE);
  throw new Error('Cannot resolve e2e.json location: no change and no session dir');
}

/**
 * @param {{ change?: string | null }} [opts]
 */
export function e2eTemplate(opts = {}) {
  return {
    change: opts.change ?? null,
    notApplicable: null,
    steps: [
      {
        name: '<boot>',
        cmd: '<command that starts the system, e.g. docker compose up -d api worker>',
      },
      {
        name: '<produce>',
        cmd: '<command that drives the real production entry point, e.g. node scripts/e2e/enqueue-analyze.mjs>',
        expect: '<regex the combined output must match — delete this field if exit code 0 is enough>',
      },
      {
        name: '<consume-assert>',
        cmd: '<command that proves the domain side effects exist, e.g. node scripts/e2e/assert-ratified.mjs>',
      },
    ],
  };
}

/**
 * Scaffold e2e.json (refuses to overwrite unless force).
 *
 * @param {{ file: string, change?: string | null, force?: boolean }} opts
 */
export function initE2e(opts) {
  if (fs.existsSync(opts.file) && !opts.force) {
    throw new Error(`e2e.json already exists: ${opts.file} (use --force to overwrite)`);
  }
  writeJson(opts.file, e2eTemplate({ change: opts.change }));
  return opts.file;
}

/**
 * Validate an e2e document.
 *
 * Valid when either:
 *  - `notApplicable` is a non-empty string (loop cannot be driven by any
 *    command — reviewers police the reason), or
 *  - `steps` is a non-empty array where every step has a filled `name` and
 *    `cmd` (no scaffold placeholders), `expect` (optional) is a valid regex,
 *    and `timeoutMs` (optional) is a positive number.
 *
 * @param {unknown} doc
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateE2e(doc) {
  /** @type {string[]} */
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, problems: ['e2e.json is not an object'] };
  }
  const e2e = /** @type {Record<string, unknown>} */ (doc);

  if (isNonEmptyString(e2e.notApplicable)) {
    return { ok: true, problems: [] };
  }

  const steps = e2e.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      ok: false,
      problems: [
        'e2e.steps is empty — add executable product-loop steps, or set notApplicable with a reason',
      ],
    };
  }

  steps.forEach((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      problems.push(`step ${i + 1}: not an object`);
      return;
    }
    const s = /** @type {Record<string, unknown>} */ (step);
    for (const field of ['name', 'cmd']) {
      const value = s[field];
      if (!isNonEmptyString(value)) {
        problems.push(`step ${i + 1} (${s.name ?? '?'}): missing ${field}`);
      } else if (/^<.*>$/.test(value.trim())) {
        problems.push(`step ${i + 1} (${s.name ?? '?'}): ${field} still has scaffold placeholder`);
      }
    }
    if (s.expect !== undefined && s.expect !== null) {
      if (!isNonEmptyString(s.expect)) {
        problems.push(`step ${i + 1} (${s.name ?? '?'}): expect must be a non-empty regex string`);
      } else if (/^<.*>$/.test(s.expect.trim())) {
        problems.push(`step ${i + 1} (${s.name ?? '?'}): expect still has scaffold placeholder`);
      } else {
        try {
          new RegExp(s.expect);
        } catch {
          problems.push(`step ${i + 1} (${s.name ?? '?'}): expect is not a valid regex`);
        }
      }
    }
    if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== 'number' || s.timeoutMs <= 0)) {
      problems.push(`step ${i + 1} (${s.name ?? '?'}): timeoutMs must be a positive number`);
    }
  });

  return { ok: problems.length === 0, problems };
}

/**
 * Hash of the step list — recorded in results so editing e2e.json after a
 * green run invalidates the results.
 *
 * @param {unknown[]} steps
 */
export function e2eStepsHash(steps) {
  return crypto.createHash('sha256').update(JSON.stringify(steps ?? [])).digest('hex');
}

/**
 * @param {string} text
 */
function outputTail(text, lines = 30) {
  if (!text) return '';
  return text.split(/\r?\n/).slice(-lines).join('\n').trim();
}

/**
 * Execute e2e steps sequentially (shell). Stops at the first failure —
 * later steps depend on earlier ones. Exit code must be 0 and `expect`
 * (when present) must match combined stdout+stderr.
 *
 * @param {{ steps?: unknown[] }} doc — a validated e2e document with steps
 * @param {{ cwd?: string }} [opts]
 */
export function runE2eSteps(doc, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const steps = Array.isArray(doc?.steps) ? doc.steps : [];
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let ok = true;

  for (const step of steps) {
    const s = /** @type {Record<string, any>} */ (step);
    if (!ok) {
      results.push({ name: s.name, cmd: s.cmd, skipped: true });
      continue;
    }
    const started = Date.now();
    const r = spawnSync(s.cmd, {
      shell: true,
      cwd,
      encoding: 'utf8',
      timeout: typeof s.timeoutMs === 'number' ? s.timeoutMs : E2E_DEFAULT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const exitCode = typeof r.status === 'number' ? r.status : null;
    let expectMatched = null;
    let stepOk = exitCode === 0;
    if (stepOk && isNonEmptyString(s.expect)) {
      expectMatched = new RegExp(s.expect).test(output);
      stepOk = expectMatched;
    }
    results.push({
      name: s.name,
      cmd: s.cmd,
      exitCode,
      expectMatched,
      ok: stepOk,
      durationMs: Date.now() - started,
      outputTail: outputTail(output),
      error: r.error ? String(r.error.message ?? r.error) : null,
    });
    if (!stepOk) ok = false;
  }

  return {
    ok,
    ranAt: new Date().toISOString(),
    stepsHash: e2eStepsHash(steps),
    steps: results,
  };
}

/**
 * @param {string} sessionDir
 */
export function e2eResultsPath(sessionDir) {
  return path.join(sessionDir, E2E_RESULTS_FILE);
}

/**
 * @param {string} sessionDir
 * @param {ReturnType<typeof runE2eSteps>} results
 */
export function writeE2eResults(sessionDir, results) {
  writeJson(e2eResultsPath(sessionDir), results);
  return e2eResultsPath(sessionDir);
}

/**
 * @param {string} sessionDir
 * @returns {Record<string, any> | null}
 */
export function loadE2eResults(sessionDir) {
  const file = e2eResultsPath(sessionDir);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/**
 * Gate check for the executable E2E acceptance. Returns the problems that
 * block `forge phase done` — empty when the loop was executed green (and the
 * results are current), or when e2e.json honestly opts out via notApplicable.
 *
 * @param {{ e2eFile: string, sessionDir: string }} opts
 * @returns {{ problems: string[], notApplicable: boolean }}
 */
export function checkE2eGate(opts) {
  /** @type {string[]} */
  const problems = [];

  if (!fs.existsSync(opts.e2eFile)) {
    problems.push(
      `e2e.json required at ${opts.e2eFile} — run forge e2e init, author the product-loop steps, then forge e2e run. Spine rows mean an async loop exists; it must be executed, not described.`,
    );
    return { problems, notApplicable: false };
  }

  let doc;
  try {
    doc = readJson(opts.e2eFile);
  } catch (err) {
    problems.push(`e2e.json unreadable: ${err instanceof Error ? err.message : err}`);
    return { problems, notApplicable: false };
  }

  const valid = validateE2e(doc);
  if (!valid.ok) {
    problems.push(...valid.problems.map((p) => `e2e: ${p}`));
    return { problems, notApplicable: false };
  }

  if (isNonEmptyString(doc.notApplicable)) {
    return { problems: [], notApplicable: true };
  }

  const results = loadE2eResults(opts.sessionDir);
  if (!results) {
    problems.push('e2e-results.json missing — run forge e2e run (a green run is required before done)');
  } else if (results.stepsHash !== e2eStepsHash(doc.steps)) {
    problems.push('e2e-results.json is stale — e2e.json changed since the last run; re-run forge e2e run');
  } else if (!results.ok) {
    const failed = Array.isArray(results.steps) ? results.steps.find((s) => s?.ok === false) : null;
    problems.push(
      `e2e run failed${failed ? ` at step "${failed.name}"` : ''} — fix and re-run forge e2e run`,
    );
  }

  return { problems, notApplicable: false };
}

/**
 * @param {string} sessionDir
 */
export function deferralsPath(sessionDir) {
  return path.join(sessionDir, DEFERRALS_FILE);
}

/**
 * @param {string} sessionDir
 * @returns {{ deferrals: Array<{ task: string, reason: string, createdAt: string, resolvedAt: string | null }> }}
 */
export function loadDeferrals(sessionDir) {
  const file = deferralsPath(sessionDir);
  if (!fs.existsSync(file)) return { deferrals: [] };
  const doc = readJson(file);
  return { deferrals: Array.isArray(doc?.deferrals) ? doc.deferrals : [] };
}

/**
 * @param {string} sessionDir
 * @param {{ task: string, reason: string }} entry
 */
export function addDeferral(sessionDir, entry) {
  if (!isNonEmptyString(entry.task)) throw new Error('Deferral requires --task <id>');
  if (!isNonEmptyString(entry.reason)) throw new Error('Deferral requires --reason "<why>"');
  const doc = loadDeferrals(sessionDir);
  if (doc.deferrals.some((d) => d.task === entry.task && !d.resolvedAt)) {
    throw new Error(`Deferral for task ${entry.task} already open`);
  }
  doc.deferrals.push({
    task: entry.task,
    reason: entry.reason,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });
  writeJson(deferralsPath(sessionDir), doc);
  return doc;
}

/**
 * @param {string} sessionDir
 * @param {string} task
 */
export function resolveDeferral(sessionDir, task) {
  const doc = loadDeferrals(sessionDir);
  const open = doc.deferrals.find((d) => d.task === task && !d.resolvedAt);
  if (!open) throw new Error(`No open deferral for task ${task}`);
  open.resolvedAt = new Date().toISOString();
  writeJson(deferralsPath(sessionDir), doc);
  return doc;
}

/**
 * @param {string} sessionDir
 */
export function openDeferrals(sessionDir) {
  return loadDeferrals(sessionDir).deferrals.filter((d) => !d.resolvedAt);
}

/**
 * @param {Record<string, unknown> | null | undefined} session
 */
export function sessionJobsSignalText(session) {
  return [session?.paceSignal, session?.slug, session?.openspecChange]
    .filter((v) => isNonEmptyString(v))
    .join(' ');
}

/**
 * Run the mechanical integrity checks for a session.
 *
 * Checks:
 *  1. No unresolved deferrals.
 *  2. Guarded files (design D1/D3, `checkGuardedFiles`) — a baseline test
 *     tracked at the session's `baseCommit`, or a forge integrity artifact
 *     regardless of age, modified or deleted without a recorded allowance.
 *  3. spine.json — **always required** (filled rows, or `notApplicable` with a
 *     reason). Keyword sniffing is not enough to decide; missing spine is how
 *     library-only platforms checkbox past gaps.
 *  4. E2E acceptance — when a spine has real rows (not notApplicable):
 *     e2e.json must exist with filled steps (or its own notApplicable reason)
 *     and e2e-results.json must record a green, current run (steps hash must
 *     match). Prose in verify-evidence.md does not satisfy this; an explicit
 *     BLOCKED marker there still means the change cannot be done. Sync-only
 *     work should prefer spine `notApplicable` over inventing a fake loop.
 *  5. Red-before-green pairing (task 5.2, design D6, `checkTddEvidence`) —
 *     only for sessions carrying `features.tddEvidence`: every completed
 *     task dir must show an ok fail-stamp chronologically before an ok
 *     pass-stamp **for the same command** in `tdd-runs.jsonl` — unless its
 *     `test-evidence.md` carries an explicit `--no-tdd --reason "<text>"`
 *     declaration (task 5.3), which exempts a task that changed no behavior
 *     (docs/config-only) and has no test cycle to record. Evidence alone
 *     never exempts — only the marker.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, unknown> }} opts
 * @returns {{ ok: boolean, problems: string[], spineFile: string, spineExists: boolean, e2eFile: string | null }}
 */
/**
 * Project-level e2e off switch: `.forge/config.json` → `e2e.disabled` set to a
 * non-empty reason string. Operator-set via `forge e2e disable "<reason>"` —
 * agents must never set it themselves. When set, the integrity gate stops
 * demanding an executed green e2e run (the most time-consuming part of a
 * session); spine, deferrals, evidence, and BLOCKED checks still apply.
 *
 * @param {string} [cwd]
 * @returns {string | null} the reason, or null when e2e is enabled
 */
export function e2eDisabledReason(cwd = process.cwd()) {
  try {
    const reason = loadProjectConfig(cwd)?.e2e?.disabled;
    return isNonEmptyString(reason) ? reason : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the top-level directory of the git work tree containing `cwd`.
 *
 * `git diff --name-status` always reports paths relative to the repo root,
 * while `git ls-tree` (as invoked by `makeGitLsTree`) reports paths relative
 * to whatever `cwd` it is given. Running the two git calls from different
 * directories — e.g. `cwd` is a subdirectory, which is exactly what happens
 * when `forge phase done` runs without an explicit `cwd` from anywhere but
 * the repo root — makes every `gitLsTree()` lookup miss silently: the diff's
 * root-relative path (`sub/a.test.mjs`) never matches ls-tree's cwd-relative
 * name set (`a.test.mjs`), so every change classifies as unguarded and the
 * backstop passes with zero problems and no warning. Resolving the root once
 * and handing it to both calls is what `guard-cli.mjs` already does via
 * `REPO_ROOT`, which is why the PreToolUse hook does not have this bug.
 *
 * @param {string} cwd
 * @returns {string}
 * @throws when `cwd` is not inside a git work tree
 */
function resolveGitRepoRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').trim();
    throw new Error(`git rev-parse --show-toplevel failed in ${cwd}: ${reason}`);
  }
  return result.stdout.trim();
}

/**
 * Files changed between `baseCommit` and the worktree — modified, deleted,
 * or typechanged, staged or unstaged. One invocation of `git diff
 * --diff-filter=MDT` against (not `--cached` against) the worktree already
 * reports staged changes: git compares the named commit straight to the
 * working tree, not through the index, so a staged-only edit shows up
 * exactly like an unstaged one — no second invocation is needed to see the
 * index.
 *
 * `--no-renames` is load-bearing, not incidental: with git's default rename
 * detection on, `git mv a.test.mjs a.disabled.mjs` (or a rename plus a
 * weakened body, still within git's similarity threshold) reports as a
 * single `R###` record — a status the `MDT` filter drops — so the guarded
 * test would escape the backstop entirely, which is precisely the "deleted
 * test never fires again" failure mode this check exists for. `--no-renames`
 * makes git report that same rename as a plain `D <old>` + `A <new>` pair
 * instead; the `D` side still names the guarded path and the filter keeps
 * it, while the added new path is dropped by `MDT` (not `A`) as an ordinary
 * addition. This also keeps every record exactly two NUL-separated fields
 * (`<status>\0<path>\0`) — a detected rename's `-z` record is three fields
 * (`R100\0<old>\0<new>\0`), which would silently mis-pair status tokens
 * against paths in the loop below if `R` were simply added to the filter
 * instead.
 *
 * `T` (typechange, e.g. a file replaced by a symlink) is in the filter for
 * the same reason `D` is: content is gone from the guarded path's normal
 * form without the path itself being touched by the test-glob classifier's
 * usual read.
 *
 * `-z` (NUL-terminated, unquoted) is load-bearing the same way it is in
 * `makeGitLsTree`: without it, git's default core.quotepath=true renders a
 * non-ASCII path as a quoted, octal-escaped string that would never match a
 * plain path.
 *
 * @param {{ cwd: string, baseCommit: string }} params
 * @returns {Array<{ status: 'M' | 'D' | 'T', path: string }>}
 * @throws when the git invocation fails (bad baseCommit, not a git repo, …)
 */
function changedGuardCandidatePaths({ cwd, baseCommit }) {
  const result = spawnSync(
    'git',
    ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=MDT', baseCommit],
    { cwd, encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : String(result.stderr || '').trim();
    throw new Error(
      `git diff --name-status -z --no-renames --diff-filter=MDT ${baseCommit} failed in ${cwd}: ${reason}`,
    );
  }
  const tokens = result.stdout.split('\0').filter(Boolean);
  /** @type {Array<{ status: 'M' | 'D' | 'T', path: string }>} */
  const changes = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    changes.push({ status: /** @type {'M'|'D'|'T'} */ (tokens[i]), path: tokens[i + 1] });
  }
  return changes;
}

/**
 * Archive-move exemption (F130). `forge change archive` / `openspec archive`
 * rename the whole change dir to `changes/archive/<YYYY-MM-DD>-<change>/`.
 * For a change that predates the session's `baseCommit`, git reports every
 * tracked file in it as deleted — and change-dir artifacts (`spine.json`,
 * `verify-evidence.md`, `openspec-verify.md`, …) are guarded regardless of age, so a routine
 * archive presented at done as "guarded file deleted without allowance".
 *
 * A deletion whose content survives byte-identical at the archived location
 * is a move, not a tamper, and is exempt. The content comparison against
 * `baseCommit` is load-bearing: a `spine.json` edited and *then* archived is
 * a modify laundered through the move, and must still refuse.
 *
 * Returns a lookup over repo-relative posix deleted paths.
 *
 * @param {{ repoRoot: string, session: Record<string, unknown>, baseCommit: string }} params
 * @returns {(relPath: string) => boolean}
 */
function makeArchiveMoveLookup({ repoRoot, session, baseCommit }) {
  const noop = () => false;
  const liveDir = resolveChangeDir({ cwd: repoRoot, session, forWrite: true });
  // No named change, or the change is still live — nothing was archived, so
  // every deletion under it (if it existed) is an ordinary finding.
  if (!liveDir || fs.existsSync(liveDir)) return noop;
  const archivedDir = resolveChangeDir({ cwd: repoRoot, session });
  if (!archivedDir || archivedDir === liveDir || !fs.existsSync(archivedDir)) return noop;
  const liveRel = path.relative(repoRoot, liveDir).split(path.sep).join('/');
  if (liveRel === '' || liveRel.startsWith('..')) return noop;
  const prefix = `${liveRel}/`;
  return function isArchiveMove(relPath) {
    if (!relPath.startsWith(prefix)) return false;
    const archivedFile = path.join(archivedDir, relPath.slice(prefix.length));
    if (!fs.existsSync(archivedFile)) return false;
    const base = spawnSync('git', ['show', `${baseCommit}:${relPath}`], { cwd: repoRoot });
    if (base.error || base.status !== 0) return false;
    return Buffer.compare(base.stdout, fs.readFileSync(archivedFile)) === 0;
  };
}

/**
 * Guarded-files integrity backstop (design D1/D3): refuses `forge phase
 * done|finish` when a guarded file (a baseline test tracked at the session's
 * `baseCommit`, or a forge integrity artifact regardless of age) was modified
 * or deleted during the session without a matching allowance — on every
 * host, whether or not the PreToolUse hook (`forge guard check`) is wired.
 * One classifier (`classifyGuarded`) serves both, so the gate and the hook
 * can never disagree.
 *
 * A missing `baseCommit` or a git failure (bad baseCommit, `cwd` outside a
 * git work tree) degrades to a skip with a printed warning — an
 * unmeasurable baseline is not a finding, but it must not be silent either.
 * A corrupt allowance ledger is different: it is an agent-writable, ordinary
 * file that is itself unguarded, so an unreadable `guard-allowances.json` is
 * a measurable, attributable fault, not an unmeasurable baseline — it always
 * becomes a problem, never a silent skip (a torn write there must not be a
 * free pass to clear every prior allowance).
 *
 * SCOPE NOTE (Minor 5): the diff this check reads only ever lists *tracked*
 * files, and `.forge/sessions/` is normally gitignored, so the
 * `integrity-artifact:` rule below only ever fires for artifacts committed
 * at the change-dir location (e.g. `openspec/changes/<change>/spine.json`).
 * A green run here does not demonstrate coverage of session-dir artifacts
 * (`sessionDir/spine.json` when there is no tracked change dir) — those are
 * untracked and invisible to `git diff` however they are edited. The same
 * scope gap covers `session.json`/`active.json` themselves (final-review
 * C2): a rewritten `baseCommit` or a deleted `features.tddEvidence` is
 * invisible here for the identical reason, on every host. The real defense
 * for those two files is `guard.mjs`'s `forge-control:` rule denying the
 * write at the hook (`forge guard check`) in the first place; this backstop
 * cannot see a tamper to a file it was never going to see in a diff.
 *
 * CONSIDERED AND NOT IMPLEMENTED (final-review C2): validating that
 * `baseCommit` is an ancestor of `HEAD` (`git merge-base --is-ancestor`) was
 * considered as an extra signal against a repointed baseline. Two reasons it
 * is not here: (1) it cannot close the actual reproduced attack anyway — a
 * `baseCommit` repointed to a commit that itself contains the tamper is, by
 * construction, still reachable from `HEAD` on a normal linear history, so
 * an ancestor check would not flag it; the only thing that closes that
 * specific attack is denying the rewrite of `session.json` in the first
 * place, which the `forge-control:` rule above does. (2) it would be a real
 * false-positive risk on its own terms — a rebase or squash-merge between
 * session start and `forge phase done` can legitimately make the original
 * `baseCommit` unreachable from the current `HEAD` with no tamper involved
 * at all, and this check has no way to tell the two apart. Blocking `done`
 * on that would trade a narrow, already-covered attack for a routine false
 * refusal in a workflow this project does not forbid.
 *
 * @param {{ cwd: string, sessionDir: string, session: Record<string, unknown> }} opts
 * @returns {{ problems: string[] }}
 */
export function checkGuardedFiles({ cwd, sessionDir, session }) {
  const baseCommit = session?.baseCommit;
  if (!isNonEmptyString(baseCommit)) {
    process.stderr.write(
      '[forge] Warning: session has no baseCommit recorded — skipping the guarded-files integrity check ' +
        '(cannot measure what changed since the session began).\n',
    );
    return { problems: [] };
  }

  let allowances;
  try {
    allowances = loadAllowances(sessionDir);
  } catch (err) {
    return {
      problems: [
        `guard-allowances.json is unreadable (${err instanceof Error ? err.message : err}) — fix or remove it ` +
          'before forge phase done; a corrupt ledger cannot be trusted to clear guarded-file findings',
      ],
    };
  }

  let repoRoot;
  let changes;
  try {
    repoRoot = resolveGitRepoRoot(cwd);
    changes = changedGuardCandidatePaths({ cwd: repoRoot, baseCommit });
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: guarded-files integrity check skipped — ${err instanceof Error ? err.message : err}\n`,
    );
    return { problems: [] };
  }

  if (changes.length === 0) return { problems: [] };

  const config = loadProjectConfig(repoRoot);
  const gitLsTree = makeGitLsTree({ cwd: repoRoot, baseCommit });
  const isArchiveMove = makeArchiveMoveLookup({ repoRoot, session, baseCommit });

  /** @type {string[]} */
  const problems = [];
  try {
    for (const { status, path: relPath } of changes) {
      const classification = classifyGuarded({ relPath, session, config, gitLsTree });
      if (!classification.guarded) continue;
      // F130: archiving the session's change moves its artifacts wholesale; a
      // byte-identical copy at the archived path makes the deletion a move.
      if (status === 'D' && isArchiveMove(relPath)) continue;
      if (findAllowance(allowances, relPath)) continue;
      const verb = status === 'D' ? 'deleted' : 'modified';
      problems.push(
        `guarded file ${verb} without allowance: ${relPath} (matches ${classification.rule}) — ` +
          `restore it, or run forge test-allow ${relPath} --reason "<why>" if the change is intentional`,
      );
    }
  } catch (err) {
    // Preserve whatever was already found — a mid-loop git failure (e.g. the
    // lazy `git ls-tree` inside gitLsTree, on its first call) must not erase
    // real findings collected from earlier entries in `changes`.
    process.stderr.write(
      `[forge] Warning: guarded-files integrity check stopped early — ${err instanceof Error ? err.message : err}\n`,
    );
  }

  return { problems };
}

/**
 * Red-before-green pairing gate (task 5.2, design D6).
 *
 * Enforced only when `session.features?.tddEvidence` is truthy — the flag
 * `forge new` writes at session creation (see `new-session.mjs`). Sessions
 * created before this flag existed, or still mid-flight without it, are
 * exempt entirely: this is what makes the flag a per-session opt-in rather
 * than a retroactive rule change (this repo's own session is one such
 * exemption — its task dirs predate `forge tdd run`).
 *
 * "Completed task dir" mapping: `tasks.md` (ADR-0002 / `plan-progress.mjs`)
 * is only ever read for aggregate checkbox COUNTS (`total`/`complete`).
 * There is no code-enforced, stable mapping from a `- [ ] N.M` checkbox id
 * to a specific `tasks/<nn-slug>/` directory name — the "nn" ordinal and
 * the slug are both free text chosen whenever a task dir is scaffolded, and
 * one tasks.md heading can spawn zero, one, or several directories (task
 * 5.2 in *this session's own* tasks.md maps to directory `07-pairing-gate`,
 * not any string transform of "5.2"). Inventing an id-keyed mapping here
 * would be a guess dressed as a rule, so this gates on directory evidence
 * instead: a task dir counts as completed when it holds `test-evidence.md`
 * **or** `tdd-runs.jsonl` — any file this session's evidence-producing
 * commands write, mirroring `score.mjs`'s own `listTaskEvidence` precedent
 * for "this task has completion evidence" (per the brief: "any evidence
 * file"). `test-evidence.md` alone was an opt-out-by-omission: a task dir
 * holding only a pass-only `tdd-runs.jsonl` (an implementer who ran `forge
 * tdd run` but never `forge evidence`) was invisible to this scope and
 * bought a free pass on the pairing gate — the gate this file exists to
 * enforce — for the price of a soft scorer deduction elsewhere. A dir with
 * *neither* file is still in progress and is never required to carry a
 * stamp pairing.
 *
 * @param {string} sessionDir
 * @returns {string[]}
 */
function completedTddTaskDirs(sessionDir) {
  const tasksDir = path.join(sessionDir, 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      const dir = path.join(tasksDir, name);
      return (
        fs.existsSync(path.join(dir, 'test-evidence.md')) || fs.existsSync(path.join(dir, 'tdd-runs.jsonl'))
      );
    })
    .sort();
}

/**
 * Parses `tdd-runs.jsonl` into usable stamps, skipping (and counting) any
 * line that is not valid JSON or does not carry the minimal shape this gate
 * needs to order and classify it. The file is agent-writable, so a
 * corrupted or hand-edited line must never crash the check — but it also
 * must never be silently treated as satisfying evidence it cannot actually
 * demonstrate: a skipped line can only ever remove a stamp from
 * consideration, which can only turn a would-be-valid pair into a reported
 * problem (fail-closed), never the reverse.
 *
 * A read failure (e.g. a directory sitting where a file is expected, or a
 * permissions error) is reported separately via `error` rather than folded
 * into an empty stamp list — an unreadable ledger is a measurable,
 * attributable fault (same discipline `checkGuardedFiles` applies to a
 * corrupt `guard-allowances.json`), not silently equivalent to "no stamps
 * yet", which would surface as the generic pairing-missing message and
 * point the operator at the wrong problem.
 *
 * Exported so `score.mjs`'s `listTaskEvidence` can reuse the same
 * fail-closed parsing when deciding whether a task dir carries tier-2
 * evidence via an executed pass-stamp — one parser, so the pairing gate and
 * the scorer can never disagree about what a line means.
 *
 * `cmd`/`args` are captured (and required, non-empty `cmd` string plus an
 * `args` array of strings) so `hasRedBeforeGreen` can require the qualifying
 * red and green stamps to name the same command (I2) — a stamp missing
 * either reads as malformed and drops out of consideration, the same
 * fail-closed direction every other field here already takes.
 *
 * @param {string} file
 * @returns {{ stamps: Array<{ expect: string, ok: boolean, exit: unknown, startedAtMs: number, line: number, cmd: string, args: string[] }>, malformed: number, error: string | null }}
 */
export function readTddRunStamps(file) {
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { stamps: [], malformed: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const lines = body.split('\n');
  /** @type {Array<{ expect: string, ok: boolean, exit: unknown, startedAtMs: number, line: number, cmd: string, args: string[] }>} */
  const stamps = [];
  let malformed = 0;
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      return;
    }
    const startedAtMs =
      typeof parsed?.startedAt === 'string' ? Date.parse(parsed.startedAt) : NaN;
    const argsValid = Array.isArray(parsed?.args) && parsed.args.every((a) => typeof a === 'string');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.expect !== 'string' ||
      typeof parsed.ok !== 'boolean' ||
      Number.isNaN(startedAtMs) ||
      typeof parsed.cmd !== 'string' ||
      parsed.cmd.length === 0 ||
      !argsValid
    ) {
      malformed += 1;
      return;
    }
    stamps.push({
      expect: parsed.expect,
      ok: parsed.ok,
      exit: parsed.exit === undefined ? null : parsed.exit,
      startedAtMs,
      line: i,
      cmd: parsed.cmd,
      args: parsed.args,
    });
  });
  return { stamps, malformed, error: null };
}

/**
 * Tuple-orders two stamps by `startedAtMs`, falling back to file line order
 * on a tie (CLI-generated timestamps can collide at millisecond precision).
 *
 * @param {{ startedAtMs: number, line: number }} a
 * @param {{ startedAtMs: number, line: number }} b
 */
function compareStampOrder(a, b) {
  return a.startedAtMs - b.startedAtMs || a.line - b.line;
}

/**
 * Ok fail-stamps, `expect: "fail", ok: true, exit: null` deliberately
 * excluded: `forge tdd run` records `exit: null` for both a spawn failure
 * (`ok: false`, never reaches here) and a signal-killed child (`ok: true`
 * under `--expect fail`) — the stamp shape cannot tell those apart, so a
 * `null` exit is not trustworthy evidence of a genuine RED.
 *
 * @param {Array<{ expect: string, ok: boolean, exit: unknown }>} stamps
 */
function okRedStamps(stamps) {
  return stamps.filter((s) => s.expect === 'fail' && s.ok === true && s.exit !== null);
}

/**
 * @param {Array<{ expect: string, ok: boolean }>} stamps
 */
function okGreenStamps(stamps) {
  return stamps.filter((s) => s.expect === 'pass' && s.ok === true);
}

/**
 * Identifies the command a stamp names, for grouping red/green stamps that
 * must match (I2). `JSON.stringify` on the tuple is enough: `cmd` is a
 * non-empty string and `args` an array of strings (`readTddRunStamps`
 * enforces both, dropping anything else as malformed), so no two distinct
 * (cmd, args) pairs can collide on this key.
 *
 * @param {{ cmd: string, args: string[] }} stamp
 * @returns {string}
 */
function stampCommandKey(stamp) {
  return JSON.stringify([stamp.cmd, stamp.args]);
}

/**
 * Whether the stamps contain an ok fail-stamp chronologically before an ok
 * pass-stamp **for the same command** (same `cmd` and `args`, in order).
 *
 * Final-review I2: the reviewer reproduced `forge tdd run --expect fail --
 * false` then `forge tdd run --expect pass -- true` clearing this gate —
 * both stamps genuine and CLI-authored, but for unrelated commands, so no
 * red→green cycle ever actually happened. Grouping by command closes that:
 * a task may legitimately carry several red→green pairs for different
 * commands (e.g. one per file touched), so this asks whether *some* command
 * has an ok fail-stamp before an ok pass-stamp, not that every stamp agrees
 * on one command.
 *
 * Per command, the earliest qualifying red is compared against every
 * qualifying green sharing that key — mirroring the pre-I2 earliest-red /
 * any-green comparison, just scoped to one command instead of the whole
 * ledger.
 *
 * @param {Array<{ expect: string, ok: boolean, exit: unknown, startedAtMs: number, line: number, cmd: string, args: string[] }>} stamps
 */
function hasRedBeforeGreen(stamps) {
  const reds = okRedStamps(stamps);
  const greens = okGreenStamps(stamps);
  if (reds.length === 0 || greens.length === 0) return false;
  /** @type {Map<string, typeof reds[number]>} */
  const earliestRedByCommand = new Map();
  for (const red of reds) {
    const key = stampCommandKey(red);
    const existing = earliestRedByCommand.get(key);
    if (!existing || compareStampOrder(red, existing) < 0) earliestRedByCommand.set(key, red);
  }
  return greens.some((green) => {
    const red = earliestRedByCommand.get(stampCommandKey(green));
    return red !== undefined && compareStampOrder(red, green) < 0;
  });
}

/**
 * @param {{ cmd: string, args: string[] }} stamp
 * @returns {string}
 */
function formatStampCommand(stamp) {
  return [stamp.cmd, ...stamp.args].join(' ');
}

/**
 * @param {Array<{ cmd: string, args: string[] }>} stamps
 * @returns {string}
 */
function formatUniqueCommands(stamps) {
  return [...new Set(stamps.map(formatStampCommand))].join('; ');
}

/**
 * Builds an actionable explanation of why `hasRedBeforeGreen` refused —
 * distinct from a generic "no evidence" message so the operator can tell
 * "no red at all" / "no green at all" apart from I2's shape: a red and a
 * green both exist, just never for the same command.
 *
 * @param {Array<{ expect: string, ok: boolean, exit: unknown, cmd: string, args: string[] }>} stamps
 * @returns {string}
 */
function describePairingGap(stamps) {
  const reds = okRedStamps(stamps);
  const greens = okGreenStamps(stamps);
  if (reds.length === 0 && greens.length === 0) return 'no ok fail-stamp or ok pass-stamp recorded';
  if (reds.length === 0) return `no ok fail-stamp recorded (pass-stamp(s) found for: ${formatUniqueCommands(greens)})`;
  if (greens.length === 0) return `no ok pass-stamp recorded (fail-stamp(s) found for: ${formatUniqueCommands(reds)})`;
  return (
    `red for: ${formatUniqueCommands(reds)}; green for: ${formatUniqueCommands(greens)} — ` +
    'no command has both a fail-stamp and a chronologically later pass-stamp'
  );
}

/**
 * Whether a task dir's `test-evidence.md` carries a genuine `--no-tdd`
 * declaration — an explicit, reviewer-visible judgement that this task has
 * no applicable red→green cycle (docs/config-only work).
 *
 * Requires BOTH, each read independently off its own line (never a
 * substring match anywhere in the file):
 *   1. `NO_TDD_MARKER` as a complete line, trimmed — so text that merely
 *      *quotes* the token inside another line (e.g. a `--summary` reading
 *      "green — see notes on <!-- forge:no-tdd-declared -->") can never
 *      satisfy this: that text always shares its line with a `- **Summary:**
 *      …` (or similar) prefix and so is never equal to the marker alone.
 *      Reviewer-found (F1a): `runRecordEvidence` now also refuses to let
 *      caller-supplied task/command/summary/tier contain this token at all,
 *      so the CLI is its only author — but this whole-line match is the
 *      layer that holds even if some other future writer is less careful.
 *   2. A `NO_TDD_REASON_LABEL` line with non-empty text after it. Without
 *      this, a bare marker appended by anything other than the CLI (a hand
 *      or Bash edit, or a file whose entire content is just the marker) read
 *      as a declaration with no reason ever recorded — reviewer-found
 *      (F1b). `--reason` is mandatory at write time (`runRecordEvidence`);
 *      this is what makes that promise actually enforced where the gate
 *      lives, not merely at the one writer that bothers to check.
 *
 * Also fails closed the way every sibling check here does: a missing file,
 * an unreadable one (e.g. a directory sitting at that path — EISDIR), or
 * prose that merely *talks about* "no tdd" without the exact marker all read
 * as "not declared". Evidence alone (a `test-evidence.md` produced by the
 * plain `--command/--exit/--summary` path) must stay gated — only this
 * explicit two-line declaration exempts, never a heuristic guess about the
 * file's contents.
 *
 * @param {string} evidenceFile
 * @returns {boolean}
 */
function hasNoTddDeclaration(evidenceFile) {
  let body;
  try {
    body = fs.readFileSync(evidenceFile, 'utf8');
  } catch {
    return false;
  }
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const hasMarkerLine = lines.some((line) => line === NO_TDD_MARKER);
  if (!hasMarkerLine) return false;
  return lines.some((line) => {
    if (!line.startsWith(NO_TDD_REASON_LABEL)) return false;
    return line.slice(NO_TDD_REASON_LABEL.length).trim().length > 0;
  });
}

/**
 * @param {{ sessionDir: string, session: Record<string, unknown> }} opts
 * @returns {{ problems: string[] }}
 */
export function checkTddEvidence({ sessionDir, session }) {
  if (!session?.features?.tddEvidence) return { problems: [] };

  /** @type {string[]} */
  const problems = [];
  const tasksDir = path.join(sessionDir, 'tasks');

  for (const taskName of completedTddTaskDirs(sessionDir)) {
    const evidenceFile = path.join(tasksDir, taskName, 'test-evidence.md');
    if (hasNoTddDeclaration(evidenceFile)) continue;

    const tddRunsFile = path.join(tasksDir, taskName, 'tdd-runs.jsonl');
    if (!fs.existsSync(tddRunsFile)) {
      problems.push(
        `task ${taskName}: tdd-runs.jsonl missing — this task is marked complete but has no recorded ` +
          `red→green evidence; run forge tdd run --task ${taskName} --expect fail -- <cmd>, then again ` +
          `--expect pass -- <cmd> once green`,
      );
      continue;
    }

    const { stamps, malformed, error } = readTddRunStamps(tddRunsFile);
    if (error) {
      problems.push(
        `task ${taskName}: tdd-runs.jsonl is unreadable (${error}) — fix or remove it before forge phase ` +
          'done; an unreadable ledger cannot be trusted to demonstrate red→green evidence',
      );
      continue;
    }
    if (malformed > 0) {
      process.stderr.write(
        `[forge] Warning: ${malformed} malformed line(s) skipped in ${tddRunsFile} — a malformed line ` +
          'can never be used to satisfy the pairing gate.\n',
      );
    }

    if (!hasRedBeforeGreen(stamps)) {
      problems.push(
        `task ${taskName}: tdd-runs.jsonl lacks an ok fail-stamp chronologically before an ok pass-stamp ` +
          `for the same command (${describePairingGap(stamps)}) — red→green evidence is required before ` +
          `forge phase done|finish (forge tdd run --task ${taskName} --expect fail -- <cmd>, then the SAME ` +
          '<cmd> again with --expect pass once green)',
      );
    }
  }

  return { problems };
}

export function runIntegrityChecks(opts) {
  /** @type {string[]} */
  const problems = [];
  const { sessionDir, session } = opts;
  const cwd = opts.cwd ?? process.cwd();

  const open = openDeferrals(sessionDir);
  if (open.length > 0) {
    problems.push(
      `unresolved deferrals: ${open.map((d) => `${d.task} (${d.reason})`).join('; ')} — resolve via forge defer resolve --task <id>`,
    );
  }

  problems.push(...checkGuardedFiles({ cwd, sessionDir, session }).problems);
  problems.push(...checkTddEvidence({ sessionDir, session }).problems);

  const spineFile = spinePath({ cwd, session, sessionDir });
  const spineExists = fs.existsSync(spineFile);

  /** @type {ReturnType<typeof validateSpine> | null} */
  let spineResult = null;
  let spineHasRows = false;
  if (!spineExists) {
    problems.push(
      `spine.json required at ${spineFile} — run forge spine init, then fill rows (or set notApplicable with a reason). Spine is mandatory for every change so capability→runtime wiring cannot be skipped by accident.`,
    );
  } else {
    try {
      const doc = readJson(spineFile);
      spineResult = validateSpine(doc);
      spineHasRows =
        Array.isArray(doc?.rows) &&
        doc.rows.length > 0 &&
        !isNonEmptyString(doc?.notApplicable);
    } catch (err) {
      spineResult = {
        ok: false,
        problems: [`spine.json unreadable: ${err instanceof Error ? err.message : err}`],
      };
    }
    if (!spineResult.ok) {
      problems.push(...spineResult.problems.map((p) => `spine: ${p}`));
    }
  }

  let e2eFile = null;
  const e2eDisabled = e2eDisabledReason(cwd);
  if (spineExists && spineHasRows) {
    if (!e2eDisabled) {
      e2eFile = e2ePath({ cwd, session, sessionDir });
      problems.push(...checkE2eGate({ e2eFile, sessionDir }).problems);
    }

    const evidenceFile = path.join(sessionDir, 'verify-evidence.md');
    if (fs.existsSync(evidenceFile) && hasBlockedMarker(fs.readFileSync(evidenceFile, 'utf8'))) {
      problems.push('verify-evidence.md contains BLOCKED — change cannot be marked done while E2E is blocked');
    }
  }

  return { ok: problems.length === 0, problems, spineFile, spineExists, e2eFile, e2eDisabled };
}
