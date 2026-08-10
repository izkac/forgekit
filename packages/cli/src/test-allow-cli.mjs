#!/usr/bin/env node
/**
 * `forge test-allow <path> --reason "<text>" [--session <id>] [--json]` —
 * appends an allowance to the session's `guard-allowances.json` ledger
 * (`guard.mjs`), which `forge guard check` (task 2.1) — and, later, the
 * integrity backstop (task 4.1) — honor to flip a guarded-file deny to an
 * allow.
 *
 * This is the only writer of the ledger: an allowance weakens a hard-deny
 * gate, so it is gate-class the same way `forge phase done`/`finish` and
 * `forge brief stamp` are — ambiguous session resolution refuses rather than
 * guessing which session's ledger to weaken (see `resolveSessionOrExit`'s
 * `strict` doc in lib.mjs).
 *
 * Exit codes: 0 recorded, 1 usage error or refusal (nothing written).
 */

import { REPO_ROOT, loadSession, resolveSessionOrExit } from './lib.mjs';
import { loadProjectConfig } from './config.mjs';
import {
  addAllowance,
  classifyGuarded,
  findAllowance,
  loadAllowances,
  makeGitLsTree,
  resolveFile,
} from './guard.mjs';

function usage() {
  process.stderr.write('Usage: forge test-allow <path> --reason "<text>" [--session <id>] [--json]\n');
}

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

let rawPath = null;
let reason = null;
let sessionIdArg = null;
let json = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--reason' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
    reason = args[(i += 1)];
  } else if (args[i] === '--session' && args[i + 1]) {
    sessionIdArg = args[(i += 1)];
  } else if (args[i] === '--json') {
    json = true;
  } else if (args[i].startsWith('-')) {
    usage();
    process.exit(1);
  } else if (rawPath === null) {
    rawPath = args[i];
  } else {
    usage();
    process.exit(1);
  }
}

if (!rawPath) {
  usage();
  process.exit(1);
}

if (reason === null || !reason.trim()) {
  process.stderr.write('forge test-allow: --reason is required and must not be empty/whitespace.\n');
  process.exit(1);
}

// Gate-class: refuse on ambiguous session resolution rather than guessing
// which session's ledger to weaken.
const sessionId = resolveSessionOrExit(sessionIdArg, { command: 'forge test-allow', strict: true });

let dir;
let session;
try {
  ({ dir, session } = loadSession(sessionId));
} catch (err) {
  process.stderr.write(
    `forge test-allow: could not read session ${sessionId}: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
}

const resolved = resolveFile(rawPath, REPO_ROOT);
if (resolved.outside) {
  // An allowance is keyed on the same repo-relative form `guard check` and
  // the (future) integrity backstop compare against. A path outside the
  // repo can never match either — `guard check` short-circuits to
  // outside-repo before ever consulting the ledger, and the backstop diffs
  // repo-relative paths — so recording one would be a permanently inert
  // entry that silently looks like a real allowance.
  process.stderr.write(
    `forge test-allow: ${resolved.abs} is outside the repo (${REPO_ROOT}) and can never be guarded — nothing recorded.\n`,
  );
  process.exit(1);
}
const relPath = resolved.rel;

// F94: refuse to record an allowance the guard can never honor. Both
// `guard check` and the integrity backstop classify with the session's
// baseCommit — a file is guarded only when it matches a test glob AND was
// tracked at baseCommit, or is an integrity/forge-control artifact — so a
// typo'd path or a glob-shaped string would sit in the ledger reading like
// a justified escape while nothing ever consults it.
if (typeof session.baseCommit === 'string' && session.baseCommit) {
  let classification = null;
  try {
    classification = classifyGuarded({
      relPath,
      config: loadProjectConfig(REPO_ROOT),
      gitLsTree: makeGitLsTree({ cwd: REPO_ROOT, baseCommit: session.baseCommit }),
    });
  } catch (err) {
    // A git failure must not block the escape hatch — warn and record.
    process.stderr.write(
      `forge test-allow: warning — could not verify whether ${relPath} is guarded (${
        err instanceof Error ? err.message : err
      }); recording anyway.\n`,
    );
  }
  if (classification && !classification.guarded) {
    process.stderr.write(
      `forge test-allow: ${relPath} is not guarded in session ${sessionId} ` +
        '(matches no guard rule at its baseCommit) — an allowance would be inert; nothing recorded.\n',
    );
    process.exit(1);
  }
}

let existing;
try {
  existing = loadAllowances(dir);
} catch (err) {
  process.stderr.write(`forge test-allow: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
const prior = findAllowance(existing, relPath);

const entry = addAllowance(dir, { path: relPath, reason, phase: session.phase ?? null });

if (json) {
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
} else {
  process.stdout.write(
    `Recorded allowance for ${entry.path}: ${entry.reason} (phase ${entry.phase ?? 'none'})\n`,
  );
  if (prior) {
    process.stdout.write(
      `Note: a prior allowance for ${entry.path} already exists (reason: ${prior.reason}).\n`,
    );
  }
}
