/**
 * Filesystem fingerprint of untracked session + Forge control paths.
 *
 * `checkGuardedFiles` reads `git diff`, which only ever lists **tracked**
 * files. `.forge/sessions/` is normally gitignored, so a shell edit of
 * `session.json`, `active.json`, or a session-dir integrity artifact is
 * invisible to that backstop. This module hashes those paths (including
 * untracked ones) and compares them to a seal written by legitimate Forge
 * writes (`saveSession`, `writeActive`, `forge tdd run`, `forge evidence`).
 *
 * Fail closed: an unreadable or malformed seal is a problem, never a skip.
 * A missing seal is not a problem — fixtures and sessions that predate this
 * file have none; the next `saveSession` creates one. Hypothesis: requiring
 * a seal on every `runIntegrityChecks` fixture would be a drive-by rewrite
 * of every integrity test, and a missing seal cannot prove a mutation
 * anyway.
 *
 * New protected files that appear after the last seal are accepted (they
 * are sealed on the next Forge write). Mutation of an already-sealed path
 * is the finding.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SEAL_BASENAME = 'integrity-seal.json';
export const SEAL_VERSION = 1;

const CONTROL_RELS = Object.freeze(['.forge/active.json', '.forge/config.json']);

/** Phases before the plan is approved; `forge phase implement` is the approval point. */
const PLANNING_PHASES = new Set(['triage', 'brainstorm', 'plan']);
/** Session-dir artifacts the agent authors during planning. */
const PLAN_ARTIFACTS = Object.freeze(['spine.json', 'e2e.json']);

/** @param {string} sessionDir @returns {string | null} — null when unreadable (fail closed: not planning). */
function readPhase(sessionDir) {
  try {
    const phase = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))?.phase;
    return typeof phase === 'string' ? phase : null;
  } catch {
    return null;
  }
}

/**
 * Basenames whose session-dir copies are sealed (control + integrity
 * artifacts). Duplicated from `guard.mjs`'s `INTEGRITY_ARTIFACTS` plus
 * `session.json` / `verify-runs.jsonl` so this module never imports
 * `guard.mjs` — `lib.mjs` loads us on every command, and `guard-cli.mjs`
 * loads both `lib.mjs` and `guard.mjs`.
 */
const SEALED_BASENAMES = new Set([
  'session.json',
  'verify-runs.jsonl',
  'spine.json',
  'e2e.json',
  'e2e-results.json',
  'verify-evidence.md',
  'openspec-verify.md',
  'spec-verify.md',
  'test-evidence.md',
  'tdd-runs.jsonl',
  'gates.json',
  'gate-results.json',
]);

/**
 * @param {string} absPath
 * @returns {string}
 */
export function hashFile(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/**
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function walkFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, acc);
    else if (entry.isFile()) acc.push(abs);
  }
  return acc;
}

/**
 * Project root that owns `<root>/.forge/sessions/<id>`.
 *
 * @param {string} sessionDir
 */
export function repoRootFromSessionDir(sessionDir) {
  return path.resolve(sessionDir, '..', '..', '..');
}

/**
 * @param {{ repoRoot: string, sessionDir: string }} opts
 * @returns {string[]} repo-relative posix paths
 */
export function listProtectedRelPaths({ repoRoot, sessionDir }) {
  /** @type {string[]} */
  const out = [];
  for (const rel of CONTROL_RELS) {
    const abs = path.join(repoRoot, rel);
    try {
      if (fs.statSync(abs).isFile()) out.push(rel);
    } catch {
      // absent is not a finding at list time
    }
  }
  if (!sessionDir) return out.sort();
  for (const abs of walkFiles(sessionDir)) {
    const base = path.basename(abs);
    if (base === SEAL_BASENAME) continue;
    if (!SEALED_BASENAMES.has(base)) continue;
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.push(rel);
  }
  return [...new Set(out)].sort();
}

/**
 * @param {{ repoRoot: string, sessionDir: string }} opts
 * @returns {{ version: number, at: string, files: Record<string, string> }}
 */
export function computeIntegrityFingerprint({ repoRoot, sessionDir }) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of listProtectedRelPaths({ repoRoot, sessionDir })) {
    const abs = path.join(repoRoot, rel);
    try {
      files[rel] = hashFile(abs);
    } catch (err) {
      throw new Error(
        `cannot hash protected path ${rel}: ${err instanceof Error ? err.message : err}`,
        { cause: err },
      );
    }
  }
  return { version: SEAL_VERSION, at: new Date().toISOString(), files };
}

/**
 * @param {string} sessionDir
 */
export function integritySealPath(sessionDir) {
  return path.join(sessionDir, SEAL_BASENAME);
}

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** Total attempts (1 try + 3 retries, per spec) and the sync pause before each retry. */
const SEAL_ATTEMPTS = 4;
const SEAL_BACKOFF_MS = Object.freeze([50, 100, 200]);

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Walk the error and its `cause` chain: `computeIntegrityFingerprint` wraps
 * hash errors in a plain `Error`, which hides the original `code`.
 *
 * @param {unknown} err
 */
function isTransientFsError(err) {
  for (let e = err, depth = 0; e && depth < 4; e = /** @type {any} */ (e).cause, depth += 1) {
    const code = /** @type {any} */ (e).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Rewrite the seal from the current filesystem. Atomic (tmp + rename) and
 * retried on EBUSY/EPERM/EACCES — a transient Windows lock must not leave the
 * previous seal behind, which the next check reads as tampering. Still
 * best-effort once attempts run out: a failed seal write must not break the
 * Forge command that just wrote a legitimate file (the next check then sees a
 * stale or missing seal and escalates).
 *
 * ponytail: fixed 4 attempts (3 retries) with 50/100/200 ms sync backoff — a ceiling, not a
 * tunable; sync because every caller (`saveSession`, `writeActive`) is sync.
 *
 * @param {{ sessionDir: string, repoRoot?: string, fsImpl?: typeof fs }} opts
 *   `fsImpl` is a test seam for injecting write failures.
 * @returns {{ path: string, fingerprint: ReturnType<typeof computeIntegrityFingerprint> } | null}
 */
export function refreshIntegritySeal({ sessionDir, repoRoot, fsImpl = fs }) {
  if (!sessionDir) return null;
  const root = repoRoot ?? repoRootFromSessionDir(sessionDir);
  const file = integritySealPath(sessionDir);
  const tmpPath = `${file}.${process.pid}.tmp`;
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        fsImpl.mkdirSync(sessionDir, { recursive: true });
        const fingerprint = computeIntegrityFingerprint({ repoRoot: root, sessionDir });
        fsImpl.writeFileSync(tmpPath, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8');
        fsImpl.renameSync(tmpPath, file);
        return { path: file, fingerprint };
      } catch (err) {
        try {
          fsImpl.rmSync(tmpPath, { force: true });
        } catch {
          // best effort — the write already failed
        }
        if (attempt >= SEAL_ATTEMPTS || !isTransientFsError(err)) throw err;
        sleepSync(SEAL_BACKOFF_MS[attempt - 1]);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not refresh integrity seal — ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}

/**
 * Compare current hashes to the last Forge-written seal.
 *
 * @param {{ cwd?: string, sessionDir: string, repoRoot?: string }} opts
 * @returns {{ problems: string[] }}
 */
export function checkIntegritySeal({ cwd, sessionDir, repoRoot }) {
  /** @type {string[]} */
  const problems = [];
  if (!sessionDir) return { problems };

  const sealFile = integritySealPath(sessionDir);
  if (!fs.existsSync(sealFile)) return { problems };

  let seal;
  try {
    seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
  } catch (err) {
    return {
      problems: [
        `integrity-seal.json is unreadable (${err instanceof Error ? err.message : err}) — ` +
          'fix or remove it before continuing; an unreadable seal cannot be trusted to say session artifacts are intact',
      ],
    };
  }
  if (!seal || typeof seal !== 'object' || !seal.files || typeof seal.files !== 'object' || Array.isArray(seal.files)) {
    return {
      problems: [
        'integrity-seal.json is malformed (expected { files: { <relpath>: <sha256> } }) — ' +
          'fix or remove it; a corrupt seal cannot be trusted',
      ],
    };
  }

  const root = repoRoot ?? (cwd ? path.resolve(cwd) : repoRootFromSessionDir(sessionDir));
  let current;
  try {
    current = computeIntegrityFingerprint({ repoRoot: root, sessionDir });
  } catch (err) {
    return {
      problems: [
        `integrity seal could not be verified — ${err instanceof Error ? err.message : err}`,
      ],
    };
  }

  // Plan artifacts are hand-authored after `forge spine init` / `forge e2e init`
  // scaffold them, so they stay editable until the plan is approved; entering
  // implement saves the session, which seals them (F19). The phase comes from
  // the live session.json, which is itself sealed — flipping it back to `plan`
  // is caught as a session.json mutation.
  const sessionRel = path.relative(root, sessionDir).split(path.sep).join('/');
  const planEditable = PLANNING_PHASES.has(readPhase(sessionDir))
    ? new Set(PLAN_ARTIFACTS.map((b) => `${sessionRel}/${b}`))
    : new Set();

  for (const [rel, expected] of Object.entries(seal.files)) {
    if (planEditable.has(rel)) continue;
    if (typeof expected !== 'string' || !expected) {
      problems.push(`integrity-seal.json has a non-hash entry for ${rel} — fail closed`);
      continue;
    }
    const actual = current.files[rel];
    if (actual === undefined) {
      problems.push(
        `guarded session artifact deleted outside PreToolUse: ${rel} — ` +
          'restore it, or re-run the forge command that legitimately writes this path',
      );
    } else if (actual !== expected) {
      problems.push(
        `untracked session artifact mutated outside PreToolUse: ${rel} — ` +
          'restore it, or re-run the forge command that legitimately writes this path',
      );
    }
  }

  return { problems };
}
