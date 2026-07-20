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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

/** @type {Record<string, { script: string, aliases?: string[], prependArgs?: string[] }>} */
const COMMANDS = {
  new: { script: 'new-session.mjs', aliases: ['session-new'] },
  status: { script: 'session-status.mjs' },
  cleanup: { script: 'cleanup-sessions.mjs' },
  phase: { script: 'set-phase.mjs', aliases: ['set-phase'] },
  prefs: { script: 'set-prefs.mjs' },
  models: { script: 'set-models.mjs' },
  'resolve-model': { script: 'resolve-model.mjs' },
  doctor: { script: 'doctor.mjs' },
  evidence: { script: 'record-evidence.mjs' },
  reminder: { script: 'session-reminder.mjs' },
  overlay: { script: 'vendor-openspec-overlays.mjs', aliases: ['overlays'] },
  install: { script: 'install.mjs', prependArgs: ['--skills', 'forge'] },
  init: { script: 'init.mjs' },
  triage: { script: 'triage-prompt.mjs' },
  change: { script: 'change.mjs' },
  spine: { script: 'spine.mjs' },
  e2e: { script: 'e2e.mjs' },
  defer: { script: 'defer.mjs' },
  'integrity-check': { script: 'integrity-check.mjs', aliases: ['integrity'] },
  score: { script: 'score-cli.mjs', aliases: ['scorecard'] },
};

function printHelp() {
  process.stdout.write(`Forge — disciplined development workflow

Usage:
  forge <command> [args...]

Commands:
  new <slug>              Create a Forge session under .forge/
  status                  Show active session
  phase <phase>           Update session phase
  cleanup                 Prune old/finished sessions
  prefs [pace]            Get/set pace preferences
  models [lane]           Get/set subagent billing (included|metered)
  resolve-model --tier …  Resolve subagent model JSON
  doctor                  Plan-engine readiness (OpenSpec or specs)
  evidence                Stamp tier-2 test-evidence.md
  reminder                Session reminder (for hooks)
  overlay                 Re-apply OpenSpec vendor overlays in this project
  install                 Alias → forgekit install --skills forge
  init                    Wire Forge commands/hooks/rules into this project
  triage                  Classify whether a prompt needs Forge triage
  change new|archive      Specs-engine change scaffold / archive
  spine init|check        Capability→runtime spine matrix (spine.json)
  e2e init|run|check      Executable product-loop acceptance (e2e.json)
  defer add|resolve|list  Deferral registry (deferred wiring = tracked debt)
  integrity-check         Mechanical integrity gate (runs at phase done)
  score [--write]         L2 session scorecard (auto-written at phase done)

Prefer \`forgekit install\` to pick multiple skills + agents at once.

Global:
  forge --help
  forge <command> --help
`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

const [cmd, ...rest] = argv;
const entry = COMMANDS[cmd] ?? Object.values(COMMANDS).find((c) => c.aliases?.includes(cmd));

if (!entry) {
  process.stderr.write(`Unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(1);
}

const args = [...(entry.prependArgs ?? []), ...rest];
const r = spawnSync(process.execPath, [path.join(SRC, entry.script), ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORGEKIT_ROOT: path.resolve(__dirname, '..', '..', '..'),
    FORGEKIT_CLI_ROOT: path.resolve(__dirname, '..'),
  },
});

process.exit(r.status ?? 1);
