#!/usr/bin/env node
/**
 * `forge exit-check` — the plan-time exit ramp's rule (D2), evaluated on
 * facts the agent supplies rather than facts read off disk.
 *
 * Group 4's original wiring pointed at `collectPlanFacts`, which returns
 * `readable: false` until a change directory exists on disk — but the
 * capability spec requires the offer *before* one is scaffolded ("no change
 * directory is scaffolded before that offer is answered"). At the only
 * moment the offer may fire, that fact source cannot exist yet, so this
 * command exists instead: the agent has just finished brainstorm and knows
 * the shape (task count, capability count, wired spine rows, high-risk
 * surface); Forge owns the rule and the record, not the read — the same
 * split group 1b already applied to prompt-time triage.
 *
 * Usage:
 *   forge exit-check --tasks N --capabilities N --spine-rows N [--high-risk] [--json]
 *
 * Exit codes (mirrors `forge triage --check`):
 *   0   the shape qualifies — offer to leave Forge for this work
 *   1   it does not — proceed to plan (also: a missing, non-numeric,
 *       negative, fractional, flag-shaped or repeated count flag fails
 *       closed to this — see `parseExitCheckArgs` and `factsFromExitCheckArgs`)
 *
 * Prints the resolved reason on stdout, in a form pasteable straight into
 * `forge phase skipped --exit-reason "<reason>"` on acceptance.
 *
 * Pure: computes and prints, writes nothing to any session. Recording stays
 * with `forge phase skipped --exit-reason` (accepted) and
 * `forge phase plan --exit-declined` (declined).
 *
 * Does not reimplement the rule — it builds `suggestExitFromPlan`'s `facts`
 * input from flags and hands it straight to the same resolver 4.1 built and
 * proved discriminates.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { suggestExitFromPlan } from './plan-facts.mjs';

/** The three flags whose value feeds a count, keyed to the `opts` field they fill. */
const COUNT_FLAGS = { '--tasks': 'tasks', '--capabilities': 'capabilities', '--spine-rows': 'spineRows' };

/**
 * Fail-closed as a property of the parser, not an accident of what `Number()`
 * does with a bad string (group review fix round, item 2). Two structural
 * rules, both enforced here rather than left to `toNonNegativeInt` below:
 *
 * 1. A value that is itself flag-shaped (starts with `--`) is never a valid
 *    count, so it is never consumed — the count flag is left exactly as if
 *    no value had been given, and the token is parsed as its own flag on the
 *    next iteration. Without this, `--tasks --high-risk` swallowed
 *    `--high-risk` as the (discarded) task count and never saw it as a flag
 *    at all — `highRisk` silently stayed `false`.
 * 2. A count flag given more than once is ambiguous input — which value did
 *    the caller mean? — so a second sighting fails the *whole* flag closed
 *    (forced to `null` after parsing), never "last one wins", even when
 *    every value it collected individually looked well-formed. This is what
 *    closes the reported reproduction fully: `--tasks --high-risk --tasks 3`
 *    parses `--high-risk` correctly under rule 1 alone, but `--tasks` was
 *    still typed twice, and a caller who typed a flag twice gets no count
 *    from it at all rather than a guess at which occurrence they meant.
 *
 * @param {string[]} argv
 * @returns {{ tasks: string|null, capabilities: string|null, spineRows: string|null, highRisk: boolean, json: boolean, help: boolean }}
 */
export function parseExitCheckArgs(argv) {
  const opts = { tasks: null, capabilities: null, spineRows: null, highRisk: false, json: false, help: false };
  const seenCountFlag = { tasks: false, capabilities: false, spineRows: false };
  const ambiguous = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const key = COUNT_FLAGS[arg];
    if (key) {
      if (seenCountFlag[key]) ambiguous.add(key);
      seenCountFlag[key] = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      }
      continue;
    }
    if (arg === '--high-risk') opts.highRisk = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  for (const key of ambiguous) opts[key] = null;
  return opts;
}

/**
 * A flag value as a non-negative integer, or `null` for anything that is
 * not unambiguously one — missing, empty, non-numeric, fractional or
 * negative. `Number('')` is `0` in JavaScript, which would otherwise read a
 * flag typo'd with no value as a genuine "zero tasks" and could trigger an
 * offer nobody supplied evidence for; this rejects it explicitly rather than
 * relying on `Number.isFinite` alone.
 *
 * @param {string | null} value
 * @returns {number | null}
 */
function toNonNegativeInt(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Build `suggestExitFromPlan`'s `facts` input from parsed flags.
 *
 * Fail-closed posture, matching every neighbouring resolver in
 * `plan-facts.mjs` (`collectPlanFacts` unreadable, `suggestCeremonyFromPlan`
 * and `suggestPaceFromPlan` both fail closed on an unreadable plan): any one
 * of the three counts missing, malformed, flag-shaped or given more than
 * once (see `parseExitCheckArgs`, which already reduces every one of those
 * to `null` here) makes the whole shape `readable: false`, which
 * `suggestExitFromPlan` already refuses to offer against. A typo'd or
 * duplicated flag must never silently read as a real count and qualify.
 *
 * @param {ReturnType<typeof parseExitCheckArgs>} opts
 * @returns {ReturnType<typeof suggestExitFromPlan> extends never ? never : { readable: boolean, tasks: number, capabilities: number, spineRows: number, highRisk: boolean }}
 */
export function factsFromExitCheckArgs(opts) {
  const tasks = toNonNegativeInt(opts.tasks);
  const capabilities = toNonNegativeInt(opts.capabilities);
  const spineRows = toNonNegativeInt(opts.spineRows);
  const readable = tasks !== null && capabilities !== null && spineRows !== null;
  return {
    readable,
    tasks: readable ? tasks : 0,
    capabilities: readable ? capabilities : 0,
    spineRows: readable ? spineRows : 0,
    highRisk: Boolean(opts.highRisk),
  };
}

export function buildExitCheckHelpText() {
  return `Usage:
  forge exit-check --tasks N --capabilities N --spine-rows N [--high-risk] [--json]

The plan-time exit ramp's rule (D2), evaluated on facts the agent supplies —
brainstorm has just finished and knows the shape. Does not read a plan off
disk: at the moment the offer must fire, nothing is scaffolded yet.

Exit codes:
  0   the shape qualifies — offer to leave Forge for this work
  1   it does not — proceed to plan (also: a --tasks/--capabilities/
      --spine-rows that is missing, non-numeric, negative, fractional,
      flag-shaped (e.g. its value looks like another flag), or given more
      than once all fail closed here — never a silent guess)

Prints the resolved reason on stdout. On acceptance, pass it straight to:
  forge phase skipped --exit-reason "<reason>"
`;
}

/**
 * The whole command, without the process boundary — importable by tests.
 *
 * @param {string[]} argv
 * @returns {{ exitCode: number, output: string, qualifies?: boolean, reason?: string }}
 */
export function runExitCheck(argv) {
  const opts = parseExitCheckArgs(argv);
  if (opts.help) {
    return { exitCode: 0, output: buildExitCheckHelpText() };
  }
  const facts = factsFromExitCheckArgs(opts);
  const { qualifies, reason } = suggestExitFromPlan(facts);
  const output = opts.json ? `${JSON.stringify({ qualifies, reason })}\n` : `${reason}\n`;
  return { exitCode: qualifies ? 0 : 1, output, qualifies, reason };
}

function main(argv = process.argv.slice(2)) {
  const { exitCode, output } = runExitCheck(argv);
  process.stdout.write(output);
  return exitCode;
}

const isDirect =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  process.exit(main());
}
