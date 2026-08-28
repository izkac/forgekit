/**
 * Test-tamper guard: shared classifier and allowance ledger.
 *
 * One classifier serves two enforcement points that must never disagree — a
 * PreToolUse hook (`forge guard check`, task 2.1) and the integrity backstop
 * (`runIntegrityChecks`, task 4.1). This module is the pure logic only: no
 * CLI, no hook, no wiring to either caller yet.
 *
 * A path is guarded when it matches a test glob AND was tracked at the
 * session's `baseCommit` (so tests written during the session stay free —
 * that's what makes hard-deny compatible with TDD), or when it is a forge
 * integrity artifact regardless of age (those are evidence; direct agent
 * edits are never legitimate). See design D2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
];

const INTEGRITY_ARTIFACTS = new Set([
  'spine.json',
  'e2e.json',
  'e2e-results.json',
  'verify-evidence.md',
  'openspec-verify.md',
  'spec-verify.md',
  'test-evidence.md',
  'tdd-runs.jsonl',
]);

/**
 * Forge's own control surface: project config, the mutable active-session
 * pointer, and every session's state file. Guarded unconditionally under
 * `.forge/` — regardless of `guard.testGlobs`, tracking state, or which
 * session is asking — because a permitted edit to any of them can turn the
 * guard off instead of merely editing the code under test: rewriting
 * `.forge/config.json` can set `guard.testGlobs` to `[]`; rewriting a
 * `session.json` can delete `baseCommit` or `features.tddEvidence`, or
 * repoint `baseCommit` to a commit that already contains the tamper; and
 * `active.json` decides which session's rules even apply when a command runs
 * with no explicit `--session`. Final-review C1/C2.
 */
const FORGE_CONTROL_BASENAMES = new Set(['config.json', 'active.json', 'session.json']);
const FORGE_DIR_PREFIX = '.forge/';

/**
 * Whether this platform's filesystem treats paths as case-insensitive
 * (macOS/APFS, Windows) or case-sensitive (Linux). Computed once and shared
 * as the default for every case-sensitive comparison the guard makes — the
 * tracked-path lookup (`makeGitLsTree`) and the glob match (`classifyGuarded`)
 * — so the two can never drift apart on a real invocation; only an explicit
 * override (as tests use) can make them disagree, and only intentionally.
 */
const DEFAULT_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * @param {string} normalized already-posix-normalized path
 * @returns {string | null} the matched basename, or null
 */
function forgeControlSurfaceBasename(normalized) {
  if (!normalized.startsWith(FORGE_DIR_PREFIX)) return null;
  const basename = path.posix.basename(normalized);
  return FORGE_CONTROL_BASENAMES.has(basename) ? basename : null;
}

/**
 * C1: an override that resolves to zero usable globs (`[]`, or an array of
 * only empty/whitespace strings) must not be read as "guard nothing" — that
 * reading turns one project-config write into a total, silent bypass with no
 * floor. Treated as a configuration error instead: fall back to the
 * defaults and say so (`warning`), so a deliberate opt-out has to be an
 * explicit, reviewable key, not an empty list.
 *
 * @param {unknown} override
 * @returns {{ globs: string[], invalid: boolean }}
 */
function resolveTestGlobs(override) {
  if (!Array.isArray(override)) return { globs: DEFAULT_TEST_GLOBS, invalid: false };
  const cleaned = override.filter((g) => typeof g === 'string' && g.trim().length > 0);
  if (cleaned.length === 0) return { globs: DEFAULT_TEST_GLOBS, invalid: true };
  return { globs: cleaned, invalid: false };
}

const TESTGLOBS_INVALID_WARNING =
  'guard.testGlobs is set but contains no usable glob strings (e.g. []) — that would silently guard nothing, ' +
  'so Forge is falling back to the default test globs instead of disabling the guard';

/**
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * @param {string} ch a single character
 * @returns {string}
 */
function escapeRegExpChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Minimal glob → RegExp: `**` matches any number of path segments (incl.
 * none), `*` matches any characters within one segment, everything else is
 * literal. No other glob syntax (`?`, `[...]`, brace expansion) is
 * supported — the default globs and any project override are expected to
 * use only `*` and `**`.
 *
 * @param {string} glob
 * @param {boolean} [caseInsensitive] when true, the literal glob tokens
 *   (e.g. ".test.", "test/", "__tests__/") match regardless of case — a
 *   case-only variant of a glob token (`src/a.TEST.mjs`) must be caught on a
 *   folding platform the same way the tracked-path lookup catches it.
 * @returns {RegExp}
 */
function globToRegExp(glob, caseInsensitive = false) {
  const g = String(glob);
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i += 2;
      if (g[i] === '/') {
        // '**/' also matches zero segments, so the following literal can
        // sit at the start of the path (e.g. '**/test/**' matches 'test/b').
        re += '(?:.*/)?';
        i += 1;
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else {
      re += escapeRegExpChar(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : undefined);
}

/**
 * @param {{ relPath: string, session?: unknown, config?: { guard?: { testGlobs?: string[] } }, gitLsTree: (relPath: string) => boolean, caseInsensitive?: boolean }} params
 *   `session` is accepted for API parity with the hook and integrity-backstop
 *   callers (task 2.1 / 4.1) but is not read here: baseline-tracking is
 *   fully delegated to the injected `gitLsTree`, which already knows the
 *   session's `baseCommit` (see `makeGitLsTree`).
 *   `caseInsensitive` defaults the same way `makeGitLsTree`'s does (see
 *   `DEFAULT_CASE_INSENSITIVE`) so the glob match here and the tracked-path
 *   lookup inside the injected `gitLsTree` agree on one platform decision
 *   (F90) — a glob token itself (".test.", "test/", ...) is a second
 *   case-sensitive comparison that must fold in step with the lookup, not
 *   independently of it.
 * @returns {{ guarded: boolean, rule: string | null, warning: string | null }}
 */
export function classifyGuarded({ relPath, config, gitLsTree, caseInsensitive = DEFAULT_CASE_INSENSITIVE }) {
  const normalized = normalizePath(relPath);
  const basename = path.posix.basename(normalized);
  const { globs, invalid } = resolveTestGlobs(config?.guard?.testGlobs);
  const warning = invalid ? TESTGLOBS_INVALID_WARNING : null;

  if (INTEGRITY_ARTIFACTS.has(basename)) {
    return { guarded: true, rule: `integrity-artifact:${basename}`, warning };
  }

  const controlBasename = forgeControlSurfaceBasename(normalized);
  if (controlBasename) {
    return { guarded: true, rule: `forge-control:${controlBasename}`, warning };
  }

  for (const glob of globs) {
    if (globToRegExp(glob, caseInsensitive).test(normalized) && gitLsTree(normalized)) {
      return { guarded: true, rule: glob, warning };
    }
  }
  return { guarded: false, rule: null, warning };
}

/**
 * Real `gitLsTree` implementation: shells out once (lazily, on first call)
 * to list every path tracked at `baseCommit`, caches the name set, and
 * returns a lookup closure. On any git failure it throws a descriptive
 * Error — callers decide fail-open vs fail-closed.
 *
 * `caseInsensitive` defaults to the current platform's filesystem semantics
 * (macOS/Windows fold case; Linux does not) but is injectable so a single
 * CI runner can exercise both branches (F90). Folding uses plain
 * `String.prototype.toLowerCase()`, which is not a total Unicode case fold —
 * e.g. the Turkish dotted capital I (U+0130) lowercases to "i" plus a
 * combining dot, not to plain "i" — so that one code point stays unguarded
 * under folding. Accepted gap: it under-guards a rare case rather than
 * over-guarding and denying legitimate edits.
 *
 * @param {{ cwd: string, baseCommit: string, caseInsensitive?: boolean }} params
 * @returns {(relPath: string) => boolean}
 */
export function makeGitLsTree({
  cwd,
  baseCommit,
  caseInsensitive = DEFAULT_CASE_INSENSITIVE,
}) {
  /** @type {Set<string> | null} */
  let names = null;
  /** @type {Set<string> | null} */
  let lowerNames = null;
  return function gitLsTree(relPath) {
    if (names === null) {
      // -z: NUL-terminated, unquoted output. Without it, git's default
      // core.quotepath=true renders non-ASCII/quote/backslash bytes as a
      // quoted, octal-escaped string (e.g. "tests/caf\303\251.test.mjs"),
      // which would never match a plain path and silently fail open.
      const result = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', baseCommit], {
        cwd,
        encoding: 'utf8',
      });
      if (result.error || result.status !== 0) {
        const reason = result.error ? result.error.message : String(result.stderr || '').trim();
        throw new Error(`git ls-tree -r -z --name-only ${baseCommit} failed in ${cwd}: ${reason}`);
      }
      names = new Set(result.stdout.split('\0').filter(Boolean));
      if (caseInsensitive) {
        lowerNames = new Set([...names].map((n) => n.toLowerCase()));
      }
    }
    const normalized = normalizePath(relPath);
    if (caseInsensitive) {
      return lowerNames.has(normalized.toLowerCase());
    }
    return names.has(normalized);
  };
}

/**
 * Resolve a CLI-supplied file argument (absolute or repo-relative) to a
 * repo-relative posix path, or flag it as outside the repo. Shared by
 * `guard-cli.mjs` (`--file`) and `test-allow-cli.mjs` (`<path>`) — the two
 * must never disagree about what a given input path means, since an
 * allowance is keyed on this same normalized form.
 *
 * @param {string} rawFile
 * @param {string} repoRoot
 * @returns {{ rel: string, outside: false } | { rel: null, outside: true, abs: string }}
 */
export function resolveFile(rawFile, repoRoot) {
  const abs = path.isAbsolute(rawFile) ? path.resolve(rawFile) : path.resolve(repoRoot, rawFile);
  const rel = path.relative(repoRoot, abs);
  const posixAbs = abs.split(path.sep).join('/');
  // `path.isAbsolute(rel)` is load-bearing, not defensive filler: on Windows,
  // `path.relative` between paths on different drives (repoRoot on C:, the
  // file on D:) cannot express the answer as a relative path and returns the
  // absolute target path instead — that case must be caught here as
  // "outside the repo", not fed to the classifier as a bogus relative path.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { rel: null, outside: true, abs: posixAbs };
  }
  return { rel: rel.split(path.sep).join('/'), outside: false };
}

/**
 * @param {string} sessionDir
 * @returns {string}
 */
function allowancesPath(sessionDir) {
  return path.join(sessionDir, 'guard-allowances.json');
}

/**
 * @param {string} sessionDir
 * @returns {Array<{ path: string, reason: string, at: string, phase: string | null }>}
 */
export function loadAllowances(sessionDir) {
  const file = allowancesPath(sessionDir);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('expected an array');
    }
    return parsed;
  } catch (err) {
    throw new Error(`malformed guard-allowances.json at ${file}: ${err.message}`);
  }
}

/**
 * Appends an allowance entry, creating the session dir and ledger file when
 * missing. Refuses (throws) when `reason` is empty/whitespace-only or
 * `path` is missing.
 *
 * @param {string} sessionDir
 * @param {{ path: string, reason: string, phase?: string | null }} entry
 * @returns {{ path: string, reason: string, at: string, phase: string | null }}
 */
export function addAllowance(sessionDir, { path: rawPath, reason, phase } = {}) {
  if (!rawPath) {
    throw new Error('addAllowance requires a path');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('addAllowance requires a non-empty reason');
  }
  const entry = {
    path: normalizePath(rawPath),
    reason: String(reason),
    at: new Date().toISOString(),
    phase: phase ?? null,
  };
  const existing = loadAllowances(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    allowancesPath(sessionDir),
    `${JSON.stringify([...existing, entry], null, 2)}\n`,
    'utf8',
  );
  return entry;
}

/**
 * @param {Array<{ path: string }>} allowances
 * @param {string} relPath
 * @param {boolean} [caseInsensitive]
 * @returns {{ path: string, reason: string, at: string, phase: string | null } | null}
 */
export function findAllowance(allowances, relPath, caseInsensitive = DEFAULT_CASE_INSENSITIVE) {
  const normalized = normalizePath(relPath);
  const comparisonPath = caseInsensitive ? normalized.toLowerCase() : normalized;
  return (
    (allowances ?? []).find((a) => {
      if (!a) return false;
      const allowancePath = normalizePath(a.path);
      return (caseInsensitive ? allowancePath.toLowerCase() : allowancePath) === comparisonPath;
    }) ?? null
  );
}

/**
 * @param {Array<{ path: string }>} allowances
 * @param {string} relPath
 * @param {boolean} [caseInsensitive]
 * @returns {boolean}
 */
export function hasAllowance(allowances, relPath, caseInsensitive = DEFAULT_CASE_INSENSITIVE) {
  return findAllowance(allowances, relPath, caseInsensitive) !== null;
}
