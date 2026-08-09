#!/usr/bin/env node
/**
 * `forge tdd run --task <nn-slug> --expect fail|pass [--session <id>] [--] <cmd> [args…]`
 *
 * Executes a test command itself and appends one JSON line to
 * `<sessionDir>/tasks/<nn-slug>/tdd-runs.jsonl` — red/green evidence as a
 * product of execution, not transcription. Consumed by the pairing gate
 * (task 5.2, not implemented here) and read by reviewers.
 *
 * `shell: false`: the command is spawned as an argv array straight to
 * execve, never through a shell string — this repo just fixed a
 * shell-injection defect in `templates/project/claude/hooks/forge-test-guard.mjs`
 * that came from building a shell command string by hand. There is no
 * Windows shim to work around here (unlike that hook's `forge`, which is a
 * `.cmd` on win32): the command under test is whatever the caller names,
 * spawned directly.
 *
 * Not gate-class: it records evidence, it does not weaken a gate. Session
 * resolution follows the non-strict pattern (`resolveSessionOrExit`, `strict:
 * false`) used by `guard-cli.mjs` / `spine.mjs` / `e2e.mjs` — an
 * ambiguous-but-resolved session (several open, active.json names one) warns
 * and proceeds; only a genuinely unresolvable session (unreadable sessions
 * dir, or several open with the pointer naming none of them) refuses.
 * `record-evidence.mjs` documents why naming the session matters when
 * several are open (a guessed session's write can clobber another session's
 * record) — but that hazard is specific to *overwriting* a file. Each run
 * here *appends* a line and never replaces one, so there is no matching
 * overwrite refusal to add: a wrong guess costs a stray line in the wrong
 * session's ledger, never the destruction of another run's evidence.
 *
 * Exit codes: 0 when the outcome matched `--expect` (including a satisfied
 * `--expect fail`, whose child process itself exited non-zero); 1 for a
 * usage error, an unresolvable session, a spawn failure, or a contradicted
 * expectation. A contradicted expectation is still stamped (`ok: false`)
 * before this exits non-zero — never hidden.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, resolveSessionOrExit, sessionPath } from './lib.mjs';

function usage() {
  process.stderr.write(
    'Usage: forge tdd run --task <nn-slug> --expect fail|pass [--session <id>] [--] <cmd> [args…]\n',
  );
}

/**
 * Splits `run`'s argv into this command's own flags and the child's argv.
 * Only `--task`, `--expect`, `--session` are recognized, in any order, up to
 * the first `--` (consumed, and parsing stops there) or the first token that
 * isn't one of those three flags (which — and everything after it — becomes
 * the child's argv). Either way, nothing past that boundary is ever
 * inspected for our own flags, so a child argument that happens to be
 * spelled `--session` (or `--task`/`--expect`) is passed through untouched.
 *
 * @param {string[]} argv
 * @returns {{ task: string|null, expect: string|null, session: string|null, cmdArgv: string[], error?: string }}
 */
export function parseArgs(argv) {
  let task = null;
  let expect = null;
  let session = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--task' || a === '--expect' || a === '--session') {
      if (argv[i + 1] === undefined) {
        return { task, expect, session, cmdArgv: [], error: `${a} requires a value` };
      }
      if (a === '--task') task = argv[i + 1];
      else if (a === '--expect') expect = argv[i + 1];
      else session = argv[i + 1];
      i += 2;
      continue;
    }
    if (a === '--') {
      i += 1;
      break;
    }
    break;
  }
  return { task, expect, session, cmdArgv: argv.slice(i) };
}

/**
 * @param {string} sid
 * @param {string} task
 * @param {Record<string, unknown>} stamp
 */
function appendStamp(sid, task, stamp) {
  const taskDir = path.join(sessionPath(sid), 'tasks', task);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'tdd-runs.jsonl');
  fs.appendFileSync(filePath, `${JSON.stringify(stamp)}\n`, 'utf8');
  return filePath;
}

function printReceipt(filePath, stamp) {
  process.stderr.write(
    `forge tdd run: stamped ${filePath}; expected=${stamp.expect}; childExit=${stamp.exit}; ok=${stamp.ok}\n`,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    usage();
    process.exit(0);
  }
  if (args[0] !== 'run') {
    usage();
    process.exit(1);
  }

  const runArgs = args.slice(1);
  if (runArgs[0] === '--help' || runArgs[0] === '-h') {
    usage();
    process.exit(0);
  }

  const parsed = parseArgs(runArgs);
  if (parsed.error) {
    process.stderr.write(`forge tdd run: ${parsed.error}\n`);
    usage();
    process.exit(1);
  }
  const { task, expect, session: sessionIdArg, cmdArgv } = parsed;

  if (!task) {
    process.stderr.write('forge tdd run: --task is required\n');
    usage();
    process.exit(1);
  }
  if (expect !== 'fail' && expect !== 'pass') {
    process.stderr.write(
      `forge tdd run: --expect must be "fail" or "pass", got: ${expect === null ? '(missing)' : expect}\n`,
    );
    usage();
    process.exit(1);
  }
  if (cmdArgv.length === 0) {
    process.stderr.write('forge tdd run: no command given\n');
    usage();
    process.exit(1);
  }

  // Refuses (exit 1, nothing written) only when there is truly no defensible
  // session to act against; warns and proceeds on an ambiguous-but-resolved
  // one. See the module doc for why that split is safe here.
  const sessionId = resolveSessionOrExit(sessionIdArg, { command: 'forge tdd run', strict: false });

  const [cmd, ...cmdArgs] = cmdArgv;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let settled = false;

  const child = spawn(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit', shell: false });

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    const durationMs = Date.now() - startedMs;
    const stamp = { cmd, args: cmdArgs, expect, exit: null, ok: false, startedAt, durationMs };
    const filePath = appendStamp(sessionId, task, stamp);
    printReceipt(filePath, stamp);
    process.stderr.write(`forge tdd run: failed to execute ${cmd}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    const durationMs = Date.now() - startedMs;
    const ok = code !== null && (expect === 'fail' ? code !== 0 : code === 0);
    const stamp = { cmd, args: cmdArgs, expect, exit: code, ok, startedAt, durationMs };
    const filePath = appendStamp(sessionId, task, stamp);
    printReceipt(filePath, stamp);
    if (!ok) {
      const outcome = code === null && signal ? `terminated by signal ${signal}` : `exited ${code}`;
      process.stderr.write(
        `forge tdd run: contradicted expectation — expected ${expect}, command ${outcome}\n`,
      );
    }
    process.exit(ok ? 0 : 1);
  });
}

main();
