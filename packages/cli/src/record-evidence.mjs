#!/usr/bin/env node
/**
 * Record tier-2 test evidence for a Forge implement task.
 *
 * Writes `.forge/sessions/<session-id>/tasks/<task>/test-evidence.md` using
 * the canonical template from the forge skill
 * (`references/test-evidence.md`). An existing file is overwritten — the
 * latest run wins. A non-zero `--exit` is refused unless `--allow-fail`
 * is passed.
 *
 * Usage:
 *   forge record-evidence --task <nn-slug> --command <cmd> --exit <code> --summary <text> [options]
 *
 * Options:
 *   --task <nn-slug>    Task directory name, e.g. 03-record-evidence (required)
 *   --command <cmd>     Test command that was run (required)
 *   --exit <code>       Exit code of the test command (required, integer)
 *   --summary <text>    Pass/fail summary, e.g. "3/3 pass" (required)
 *   --tier <label>      Tier label (default: "2 (task-scoped — not full workspace unless noted)")
 *   --session <id>      Session id (default: sessionId from .forge/active.json)
 *   --allow-fail        Write evidence even when --exit is non-zero
 *   --forge-dir <path>  Forge root directory (default: .forge under cwd)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unfinishedSessions } from './lib.mjs';

export const DEFAULT_TIER = '2 (task-scoped — not full workspace unless noted)';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    task: null,
    command: null,
    exit: null,
    summary: null,
    tier: null,
    session: null,
    allowFail: false,
    forgeDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task') opts.task = argv[++i];
    else if (arg === '--command') opts.command = argv[++i];
    else if (arg === '--exit') opts.exit = argv[++i];
    else if (arg === '--summary') opts.summary = argv[++i];
    else if (arg === '--tier') opts.tier = argv[++i];
    else if (arg === '--session') opts.session = argv[++i];
    else if (arg === '--allow-fail') opts.allowFail = true;
    else if (arg === '--forge-dir') opts.forgeDir = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

/**
 * Render the canonical test-evidence template.
 *
 * @param {{ task: string, tier: string, command: string, exit: number, summary: string, runAt: string }} fields
 * @returns {string}
 */
export function buildEvidence({ task, tier, command, exit, summary, runAt, session, sessionFrom }) {
  return [
    `# Test evidence — Task ${task}`,
    '',
    // Which session this was recorded against, and **how that was decided** —
    // the second half is the honest part. The id alone is written from the same
    // variable as the path, so it can only ever agree with itself; what a reader
    // needs to know is whether it was named or guessed from the pointer.
    ...(session ? [`- **Session:** ${session}${sessionFrom ? ` (${sessionFrom})` : ''}`] : []),
    `- **Tier:** ${tier}`,
    `- **Command:** \`${command}\``,
    `- **Exit code:** ${exit}`,
    `- **Summary:** ${summary}`,
    `- **Run at:** ${runAt}`,
    '- **Recorded by:** implementer subagent (coordinator transcript)',
    '',
  ].join('\n');
}

/**
 * Resolve the session id: explicit `--session` wins, otherwise the sessionId
 * from `<forgeDir>/active.json`.
 *
 * @param {string | null} session
 * @param {string} forgeDir
 * @returns {string | null}
 */
function resolveSessionId(session, forgeDir) {
  if (session) return { id: session, warning: null, ambiguous: false };

  // THIS FILE WAS THE THIRTEENTH CALL SITE AND APPEARED IN NO AUDIT. It carried
  // its own copy of "read active.json", so a sweep looking for `readActive`
  // importers could not see it. The lesson is the audit's: the criterion has to
  // be "decides which session to act on", never "imports the helper the last
  // bug used".
  //
  // The first fix borrowed the *enumerator* and kept its own decision, which is
  // the same mistake one layer down — it wrote even where the shared resolver
  // would have answered "no defensible session", including into a finished one.
  // This routes the decision and keeps only the severity, which is this
  // command's to choose.
  const candidates = unfinishedSessions(path.join(forgeDir, 'sessions'));
  if (candidates === null) {
    return { id: null, warning: `could not read ${path.join(forgeDir, 'sessions')}`, ambiguous: true };
  }
  /** @type {string | null} */
  let active = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(forgeDir, 'active.json'), 'utf8'));
    if (typeof parsed?.sessionId === 'string') active = parsed.sessionId;
  } catch {
    active = null;
  }
  const activeIsOpen = active !== null && candidates.some((c) => c.id === active);
  if (candidates.length > 1) {
    return activeIsOpen
      ? {
          id: active,
          ambiguous: true,
          warning:
            `${candidates.length} sessions are unfinished; recording against ${active} ` +
            '(from .forge/active.json). Pass --session <id> to record against another.',
        }
      : { id: null, ambiguous: true, warning: `${candidates.length} sessions are unfinished and .forge/active.json names none of them` };
  }
  if (activeIsOpen) return { id: active, warning: null, ambiguous: false };
  // A pointer naming finished work must not win over the one session still
  // open — evidence recorded against a closed session is evidence nobody reads.
  if (candidates.length === 1) return { id: candidates[0].id, warning: null, ambiguous: false };
  // Nothing open to be ambiguous *between* — a project whose sessions predate
  // `session.json`, or one whose only session is finished. The pointer is the
  // only answer there is, and there is no rival for it to be wrong about.
  // Matches `lib.mjs`'s `resolveSessionId`, deliberately: two resolvers that
  // disagree about the same edge is how this class of bug starts.
  return { id: active, ambiguous: false, warning: null };
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @param {() => Date} [now]
 * @returns {{ exitCode: number; message: string }}
 */
export function runRecordEvidence(opts, cwd = process.cwd(), now = () => new Date()) {
  for (const field of ['task', 'command', 'exit', 'summary']) {
    if (!opts[field]) {
      return { exitCode: 1, message: `--${field} is required` };
    }
  }

  const testExit = Number(opts.exit);
  if (!Number.isInteger(testExit)) {
    return { exitCode: 1, message: `--exit must be an integer, got: ${opts.exit}` };
  }

  const forgeDir = path.resolve(cwd, opts.forgeDir ?? '.forge');
  const {
    id: sessionId,
    warning: sessionWarning,
    ambiguous: sessionAmbiguous,
  } = resolveSessionId(opts.session, forgeDir);
  if (!sessionId) {
    return {
      exitCode: 1,
      message: sessionWarning
        ? `Cannot tell which session to record against — ${sessionWarning}. Pass --session <id>.`
        : 'No active session. Run forge:new first or pass --session.',
    };
  }
  if (sessionWarning) process.stderr.write(`[forge] Warning: ${sessionWarning}\n`);

  const sessionDir = path.join(forgeDir, 'sessions', sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { exitCode: 1, message: `Session dir not found: ${sessionDir} (session ${sessionId})` };
  }

  if (testExit !== 0 && !opts.allowFail) {
    return {
      exitCode: 1,
      message: `Refusing to record failing evidence (exit code ${testExit}). Fix the tests and re-run, or pass --allow-fail to record anyway.`,
    };
  }

  const taskDir = path.join(sessionDir, 'tasks', opts.task);
  const filePath = path.join(taskDir, 'test-evidence.md');

  // OVERWRITING SOMEBODY ELSE'S RUN IS NOT RECOVERABLE. The file is gitignored,
  // `score.mjs` reads its exit code into the evidence ratio, and that lands in
  // the durable ledger — so a guessed session that clobbers an existing
  // `test-evidence.md` destroys a record and moves another change's score.
  //
  // THE GUARD CANNOT ASK THE FILE WHOSE IT IS. A previous version wrote a
  // `- **Session:** <id>` header and compared it against the session it had
  // resolved to. Both come from the same variable — the header is written from
  // `sessionId`, and the path is `sessions/<sessionId>/tasks/…` — so the
  // comparison was a tautology that could only fire on files the product cannot
  // produce. It read as a guard and was a no-op: an agent working on A ran the
  // bare command, the pointer said B, and B's evidence was replaced by A's
  // failing run at exit 0, with the file still claiming it was B's.
  //
  // When the session was a guess, there is nothing on disk that knows better.
  // So: creating a new file on a guess is a stray file and only warns;
  // *replacing* one refuses, and `--session` is the way through — naming the
  // session makes the resolution certain, after which re-runs overwrite freely.
  if (sessionAmbiguous && fs.existsSync(filePath)) {
    return {
      exitCode: 1,
      message:
        `Refusing to overwrite existing evidence for task ${opts.task} in session ${sessionId} ` +
        'while more than one session is unfinished — this session was resolved from ' +
        '.forge/active.json, not named, so it may not be the one this run belongs to.\n' +
        'Re-run with --session <id>. Naming it also lets later runs of the same task overwrite freely.',
    };
  }
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    buildEvidence({
      task: opts.task,
      session: sessionId,
      sessionFrom: opts.session
        ? 'named with --session'
        : sessionAmbiguous
          ? 'resolved from .forge/active.json while several sessions were open'
          : null,
      tier: opts.tier ?? DEFAULT_TIER,
      command: opts.command,
      exit: testExit,
      summary: opts.summary,
      runAt: now().toISOString(),
    }),
    'utf8',
  );

  return { exitCode: 0, message: `wrote: ${filePath}` };
}

function printHelp() {
  console.log(`Usage: forge record-evidence --task <nn-slug> --command <cmd> --exit <code> --summary <text> [options]

Record tier-2 test evidence for a Forge implement task at
.forge/sessions/<session-id>/tasks/<task>/test-evidence.md (latest run wins).

Options:
  --task <nn-slug>    Task directory name, e.g. 03-record-evidence (required)
  --command <cmd>     Test command that was run (required)
  --exit <code>       Exit code of the test command (required, integer)
  --summary <text>    Pass/fail summary, e.g. "3/3 pass" (required)
  --tier <label>      Tier label (default: "${DEFAULT_TIER}")
  --session <id>      Session id (default: sessionId from .forge/active.json)
  --allow-fail        Write evidence even when --exit is non-zero
  --forge-dir <path>  Forge root directory (default: .forge under cwd)
  -h, --help          Show this help
`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = runRecordEvidence(opts);
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
