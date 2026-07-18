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
export function buildEvidence({ task, tier, command, exit, summary, runAt }) {
  return [
    `# Test evidence — Task ${task}`,
    '',
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
  if (session) return session;
  const activeFile = path.join(forgeDir, 'active.json');
  if (!fs.existsSync(activeFile)) return null;
  try {
    const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    return typeof active?.sessionId === 'string' ? active.sessionId : null;
  } catch {
    return null;
  }
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
  const sessionId = resolveSessionId(opts.session, forgeDir);
  if (!sessionId) {
    return { exitCode: 1, message: 'No active session. Run forge:new first or pass --session.' };
  }

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
  fs.mkdirSync(taskDir, { recursive: true });

  const filePath = path.join(taskDir, 'test-evidence.md');
  fs.writeFileSync(
    filePath,
    buildEvidence({
      task: opts.task,
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
