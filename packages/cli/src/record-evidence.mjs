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
export function buildEvidence({ task, tier, command, exit, summary, runAt, session }) {
  return [
    `# Test evidence — Task ${task}`,
    '',
    // Which session recorded it. Without this, a re-run cannot tell its own
    // earlier evidence from a neighbour's, so the guard against clobbering
    // somebody else's run had to refuse *every* overwrite in a project with two
    // sessions open — freezing whatever ran first, failing or not.
    ...(session ? [`- **Session:** ${session}`] : []),
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

  // OVERWRITING SOMEBODY ELSE'S RUN IS NOT RECOVERABLE. This file is
  // gitignored, `score.mjs` reads it into the evidence ratio, and that lands in
  // the durable ledger — so a guessed session that clobbers an existing
  // `test-evidence.md` destroys a record and moves another change's score.
  //
  // The question is whose evidence is already there, not how many sessions the
  // project happens to have open. Keying on the latter refused every re-run of
  // `implement.md`'s bare command in a two-session project — freezing the first
  // run's evidence, failing or not, and printing "recording against A"
  // immediately before refusing to.
  if (sessionAmbiguous && fs.existsSync(filePath)) {
    let owner = null;
    try {
      owner = /^- \*\*Session:\*\* (.+)$/m.exec(fs.readFileSync(filePath, 'utf8'))?.[1] ?? null;
    } catch {
      owner = null;
    }
    // `null` is evidence written before this field existed: unattributable, and
    // this is the one branch where guessing wrong destroys a record.
    if (owner !== sessionId) {
      return {
        exitCode: 1,
        message:
          `Refusing to overwrite evidence for task ${opts.task} that ${owner ? `belongs to session ${owner}` : 'names no session'}, ` +
          `while more than one session is unfinished and this run resolved to ${sessionId}.\n` +
          'Pass --session <id> to say which one this run belongs to.',
      };
    }
  }
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    buildEvidence({
      task: opts.task,
      session: sessionId,
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
