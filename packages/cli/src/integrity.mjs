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
import { readJson, writeJson } from './lib.mjs';
import { DEFAULT_SPECS_DIR, resolveProjectPlanEngine } from './plan-engine.mjs';

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
 * `changes/<change>/` to `changes/archive/<YYYY-MM-DD>-<change>/`, so the
 * done-gate integrity check (which runs *after* archive in the finish flow)
 * would otherwise never find spine.json/e2e.json. Returns null if no match.
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
  const change = session && isNonEmptyString(session.openspecChange) ? session.openspecChange : null;
  if (!change) return null;

  const openspecChanges = path.join(cwd, 'openspec', 'changes');
  const openspecDir = path.join(openspecChanges, change);
  if (session.planType === 'openspec') return liveOrArchived(openspecChanges, change);

  let specsRoot = DEFAULT_SPECS_DIR;
  try {
    specsRoot = resolveProjectPlanEngine(cwd, { useUserDefault: false }).dir;
  } catch {
    // keep default
  }
  const specsChanges = path.join(cwd, specsRoot, 'changes');
  const specsDir = path.join(specsChanges, change);
  if (session.planType === 'specs') return liveOrArchived(specsChanges, change);

  // planType unknown — prefer whichever exists (live first, then archived)
  if (fs.existsSync(openspecDir)) return openspecDir;
  if (fs.existsSync(specsDir)) return specsDir;
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
export function spinePath(opts = {}) {
  const changeDir = resolveChangeDir(opts);
  if (changeDir) return path.join(changeDir, SPINE_FILE);
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
  if (changeDir) return path.join(changeDir, E2E_FILE);
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
 *  2. spine.json — **always required** (filled rows, or `notApplicable` with a
 *     reason). Keyword sniffing is not enough to decide; missing spine is how
 *     library-only platforms checkbox past gaps.
 *  3. E2E acceptance — when a spine has real rows (not notApplicable):
 *     e2e.json must exist with filled steps (or its own notApplicable reason)
 *     and e2e-results.json must record a green, current run (steps hash must
 *     match). Prose in verify-evidence.md does not satisfy this; an explicit
 *     BLOCKED marker there still means the change cannot be done. Sync-only
 *     work should prefer spine `notApplicable` over inventing a fake loop.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, unknown> }} opts
 * @returns {{ ok: boolean, problems: string[], spineFile: string, spineExists: boolean, e2eFile: string | null }}
 */
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
  if (spineExists && spineHasRows) {
    e2eFile = e2ePath({ cwd, session, sessionDir });
    problems.push(...checkE2eGate({ e2eFile, sessionDir }).problems);

    const evidenceFile = path.join(sessionDir, 'verify-evidence.md');
    if (fs.existsSync(evidenceFile) && /\bBLOCKED\b/.test(fs.readFileSync(evidenceFile, 'utf8'))) {
      problems.push('verify-evidence.md contains BLOCKED — change cannot be marked done while E2E is blocked');
    }
  }

  return { ok: problems.length === 0, problems, spineFile, spineExists, e2eFile };
}
