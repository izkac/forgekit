/**
 * Whether one test command passed (specs/changes/escape-replays). Shared by calibration and the
 * verifier's grader, which gets a copy next to it in the task's `tests/`, so both judge a run the
 * same way. No imports: it must run from the copy.
 *
 * A bare exit code is not enough: the agent controls the code the runner loads, and code that calls
 * `process.exit(0)` ends a run "successfully" without a test having run. So a run passes only when
 * the command exits 0 and, where the output holds a runner summary, it reports at least one passing
 * test and no failing one. A summary is required when the command names Jest, Vitest or
 * `node --test`.
 *
 * ponytail: the ceiling is the summary text. Agent code that prints a forged summary and exits 0
 * is believed, and a command that is not one of those three runners (`npm test`, pytest, go test)
 * is judged by its exit code alone. Closing it means a runner-owned reporter per runner.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** @param {string} word */
const count = (word, text) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);

/**
 * The runner summaries in some output, summed: Jest `Tests:  1 failed, 2 passed, 3 total`, Vitest
 * `Tests  1 failed | 2 passed (3)`, and `node --test` `# pass 2` / `ℹ pass 2` (TAP or spec reporter).
 * Node reports a test file that ran no test as one passing test named by the file; those do not
 * count, since that is what a file looks like when the code under test exited early.
 *
 * @param {string} output
 * @returns {{ recognised: boolean, passed: number, failed: number }}
 */
export function parseSummary(output) {
  const text = String(output).replace(ANSI, '');
  let recognised = false;
  let passed = 0;
  let failed = 0;
  for (const m of text.matchAll(/^[ \t]*Tests:[ \t]+(.*)$/gm)) {
    recognised = true;
    passed += count('passed', m[1]);
    failed += count('failed', m[1]);
  }
  for (const m of text.matchAll(/^[ \t]*Tests[ \t]+(?!:)(.*\d.*)$/gm)) {
    recognised = true;
    passed += count('passed', m[1]);
    failed += count('failed', m[1]);
  }
  let nodePass = null;
  for (const m of text.matchAll(/^[ \t]*(?:#|ℹ)[ \t]+(pass|fail|cancelled)[ \t]+(\d+)[ \t]*$/gm)) {
    recognised = true;
    if (m[1] === 'pass') nodePass = (nodePass ?? 0) + Number(m[2]);
    else failed += Number(m[2]);
  }
  if (nodePass !== null) {
    const files = [...text.matchAll(/^[ \t]*(?:✔|ok \d+ -)[ \t]+(\S+\.[cm]?[jt]sx?)(?:[ \t]+\([\d.]+m?s\))?[ \t]*$/gm)].length;
    passed += Math.max(0, nodePass - files);
  }
  return { recognised, passed, failed };
}

/** Whether a command is Jest, Vitest or `node --test`, whose summary must be present. */
export function namesKnownRunner(/** @type {string[]} */ argv) {
  const words = argv.map((a) => String(a).replace(/\\/g, '/').split('/').pop() ?? '');
  if (words.some((w) => /^(?:jest|vitest)(?:\.[cm]?js|\.cmd)?$/.test(w))) return true;
  return /^node(?:\.exe)?$/.test(words[0] ?? '') && argv.includes('--test');
}

/**
 * @param {{ argv: string[], exit: number | null, output: string }} run
 * @returns {{ ok: boolean, note: string }}
 */
export function judge({ argv, exit, output }) {
  if (exit !== 0) return { ok: false, note: `exit ${exit}` };
  const s = parseSummary(output);
  if (!s.recognised) {
    return namesKnownRunner(argv)
      ? { ok: false, note: 'exit 0 but the runner printed no test summary' }
      : { ok: true, note: 'passed' };
  }
  if (s.failed > 0) return { ok: false, note: `exit 0 but the summary reports ${s.failed} failing` };
  if (s.passed < 1) return { ok: false, note: 'exit 0 but the summary reports no passing test' };
  return { ok: true, note: 'passed' };
}
