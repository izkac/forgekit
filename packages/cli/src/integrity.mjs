/**
 * Forge runtime-integrity mechanics: spine matrix, deferral registry,
 * and the integrity checks that gate `forge phase done|finish`.
 *
 * Spine matrix — `spine.json` in the change dir (or session dir when the
 * session has no tracked change). One row per capability/REQ cluster:
 * library → runtime owner → writes → reads → UI consumer → evidence.
 * Library-only rows (missing runtime owner / writes / evidence) fail
 * validation, so "wire later" cannot be checkboxed past `forge phase done`.
 *
 * Deferral registry — `deferrals.json` in the session dir. Reviewers may only
 * accept "wiring deferred" when a registered deferral names the open task;
 * unresolved deferrals block done/finish.
 */

import fs from 'node:fs';
import path from 'node:path';
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
export function resolveChangeDir(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const session = opts.session ?? null;
  const change = session && isNonEmptyString(session.openspecChange) ? session.openspecChange : null;
  if (!change) return null;

  const openspecDir = path.join(cwd, 'openspec', 'changes', change);
  if (session.planType === 'openspec') return openspecDir;

  let specsRoot = DEFAULT_SPECS_DIR;
  try {
    specsRoot = resolveProjectPlanEngine(cwd, { useUserDefault: false }).dir;
  } catch {
    // keep default
  }
  const specsDir = path.join(cwd, specsRoot, 'changes', change);
  if (session.planType === 'specs') return specsDir;

  // planType unknown — prefer whichever exists
  if (fs.existsSync(openspecDir)) return openspecDir;
  if (fs.existsSync(specsDir)) return specsDir;
  return openspecDir;
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
 *  2. spine.json — required when jobs/workers are in scope (signal text) or a
 *     spine already exists; must validate.
 *  3. verify-evidence.md — when a spine with rows exists: must exist and
 *     contain a product-loop section; an explicit BLOCKED marker means the
 *     change cannot be done.
 *
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, unknown> }} opts
 * @returns {{ ok: boolean, problems: string[], spineFile: string, spineExists: boolean }}
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
  const jobsInScope = JOBS_SIGNAL_RE.test(sessionJobsSignalText(session));

  /** @type {ReturnType<typeof validateSpine> | null} */
  let spineResult = null;
  let spineHasRows = false;
  if (spineExists) {
    try {
      const doc = readJson(spineFile);
      spineResult = validateSpine(doc);
      spineHasRows = Array.isArray(doc?.rows) && doc.rows.length > 0 && !isNonEmptyString(doc?.notApplicable);
    } catch (err) {
      spineResult = { ok: false, problems: [`spine.json unreadable: ${err instanceof Error ? err.message : err}`] };
    }
    if (!spineResult.ok) {
      problems.push(...spineResult.problems.map((p) => `spine: ${p}`));
    }
  } else if (jobsInScope) {
    problems.push(
      `spine.json required (jobs/workers in scope) but missing at ${spineFile} — run forge spine init (or set notApplicable with a reason)`,
    );
  }

  if (spineExists && spineHasRows) {
    const evidenceFile = path.join(sessionDir, 'verify-evidence.md');
    if (!fs.existsSync(evidenceFile)) {
      problems.push('verify-evidence.md missing — jobs/workers changes need product-loop evidence');
    } else {
      const body = fs.readFileSync(evidenceFile, 'utf8');
      if (/\bBLOCKED\b/.test(body)) {
        problems.push('verify-evidence.md contains BLOCKED — change cannot be marked done while E2E is blocked');
      } else if (!/product[- ]loop/i.test(body)) {
        problems.push(
          'verify-evidence.md has no "Product loop" section — a single job slice is not platform E2E; record the closed producer→consumer loop (or BLOCKED)',
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, spineFile, spineExists };
}
