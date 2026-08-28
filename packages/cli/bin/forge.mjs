#!/usr/bin/env node
/**
 * Forge CLI — session orchestration, prefs, models, project init.
 *
 * Usage: forge <command> [args...]
 * Install: forge install → forgekit install --skills forge …
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findRepoRoot } from '../src/repo-root.mjs';
import { isVersionFlag, versionLine } from '../src/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

/** @type {Record<string, { script: string, aliases?: string[], prependArgs?: string[] }>} */
const COMMANDS = {
  new: { script: 'new-session.mjs', aliases: ['session-new'] },
  status: { script: 'session-status.mjs' },
  cleanup: { script: 'cleanup-sessions.mjs' },
  phase: { script: 'set-phase.mjs', aliases: ['set-phase'] },
  checkpoint: { script: 'checkpoint.mjs', aliases: ['ckpt'] },
  prefs: { script: 'set-prefs.mjs' },
  models: { script: 'set-models.mjs' },
  'resolve-model': { script: 'resolve-model.mjs' },
  'enforce-model': { script: 'enforce-model.mjs' },
  doctor: { script: 'doctor.mjs' },
  evidence: { script: 'record-evidence.mjs' },
  reminder: { script: 'session-reminder.mjs' },
  overlay: { script: 'vendor-openspec-overlays.mjs', aliases: ['overlays'] },
  install: { script: 'install.mjs', prependArgs: ['--skills', 'forge'] },
  init: { script: 'init.mjs' },
  triage: { script: 'triage-prompt.mjs' },
  'exit-check': { script: 'exit-check.mjs' },
  change: { script: 'change.mjs' },
  spine: { script: 'spine.mjs' },
  e2e: { script: 'e2e.mjs' },
  gate: { script: 'gate.mjs' },
  guard: { script: 'guard-cli.mjs' },
  'test-allow': { script: 'test-allow-cli.mjs' },
  tdd: { script: 'tdd-run.mjs' },
  defer: { script: 'defer.mjs' },
  'integrity-check': { script: 'integrity-check.mjs', aliases: ['integrity'] },
  score: { script: 'score-cli.mjs', aliases: ['scorecard'] },
  fleet: { script: 'fleet.mjs' },
  brief: { script: 'brief-cli.mjs' },
  finding: { script: 'findings-cli.mjs', aliases: ['findings'] },
  metrics: { script: 'metrics-cli.mjs' },
  'review-label': { script: 'review-label-cli.mjs' },
  analyze: { script: 'analyze-cli.mjs', aliases: ['analyse'] },
};

function printHelp() {
  process.stdout.write(`Forge — disciplined development workflow

Usage:
  forge <command> [args...]

Commands:
  new <slug>              Create a Forge session under .forge/
  status                  Show active session
  phase <phase>           Update session phase
  checkpoint              Commit the group's work (opt-in; never pushes)
  cleanup                 Prune old/finished sessions
  prefs [pace]            Get/set pace preferences
  models [lane]           Get/set subagent billing (included|metered)
  resolve-model --tier …  Resolve subagent model JSON
  enforce-model           PreToolUse hook body: hold dispatches to models.local.json
  doctor                  Plan-engine readiness (OpenSpec or specs)
  evidence                Stamp tier-2 test-evidence.md
  reminder                Session reminder (for hooks)
  overlay                 Re-apply OpenSpec vendor overlays in this project
  install                 Alias → forgekit install --skills forge
  init                    Wire Forge commands/hooks/rules into this project
  triage                  Classify whether a prompt needs Forge triage
  exit-check --tasks N --capabilities N --spine-rows N [--high-risk] [--json]  Plan-time exit ramp rule (0=qualifies, 1=proceed to plan)
  change new|archive      Specs-engine change scaffold / archive
  spine init|check        Capability→runtime spine matrix (spine.json)
  e2e init|run|check      Executable product-loop acceptance (e2e.json)
  e2e disable|enable      Operator-only project e2e off switch
  gate init|check|status  Opt-in per-group executable gates (gates.json; .forge/config.json → gates.enabled)
  guard check --file <path> [--json]  Guarded-file check (used by the test-guard hook)
  test-allow <path> --reason "<why>"  Record a guard allowance (escape hatch)
  tdd run --task <nn-slug> --expect fail|pass [--] <cmd>  Execute + stamp red/green evidence
  defer add|resolve|list  Deferral registry (deferred wiring = tracked debt)
  integrity-check         Mechanical integrity gate (runs at phase done)
  score [--write]         L2 session scorecard (auto-written at phase done)
  fleet list|report|watch|view|send|sync  Cross-project control terminal + trend
  brief stamp|check|open  Operator brief (plain-language HTML, gates implement)
  finding add|list|resolve    Findings ledger — give an observation a home
  metrics collect         Harvest host transcripts → session metrics.json
  analyze [--json]        Coverage, per-model/phase totals, policy skip rate

Prefer \`forgekit install\` to pick multiple skills + agents at once.

Global:
  forge --help
  forge --version
  forge <command> --help
`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

if (isVersionFlag(argv[0])) {
  process.stdout.write(versionLine('forge'));
  process.exit(0);
}

const [cmd, ...rest] = argv;
const entry = COMMANDS[cmd] ?? Object.values(COMMANDS).find((c) => c.aliases?.includes(cmd));

if (!entry) {
  process.stderr.write(`Unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(1);
}

// Every subcommand is project-scoped, so run it from the project root rather
// than wherever the shell happens to sit: `cd crates && forge status` used to
// report "no session" and `forge new` would have written a second .forge tree
// inside the workspace. An explicit relative `--cwd` still means what the
// caller typed, so absolutize it against the invocation dir first.
const invokedFrom = process.cwd();
const repoRoot = findRepoRoot(invokedFrom);
const args = [...(entry.prependArgs ?? []), ...rest].map((arg, i, all) =>
  i > 0 && all[i - 1] === '--cwd' && !path.isAbsolute(arg) ? path.resolve(invokedFrom, arg) : arg,
);

const stdioGuardOption = `--require=${JSON.stringify(path.join(SRC, 'stdio-guard.cjs'))}`;
const childNodeOptions = [stdioGuardOption, process.env.NODE_OPTIONS].filter(Boolean).join(' ');

const r = spawnSync(process.execPath, [path.join(SRC, entry.script), ...args], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: {
    ...process.env,
    FORGE_INVOKED_FROM: invokedFrom,
    FORGEKIT_ROOT: path.resolve(__dirname, '..', '..', '..'),
    FORGEKIT_CLI_ROOT: path.resolve(__dirname, '..'),
    NODE_OPTIONS: childNodeOptions,
    FORGEKIT_STDIO_GUARD_OPTION: stdioGuardOption,
  },
});

process.exit(r.status ?? 1);
