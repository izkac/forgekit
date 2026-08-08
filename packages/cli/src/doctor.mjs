#!/usr/bin/env node
/**
 * Forge readiness checks (OpenSpec project + CLI).
 *
 * Usage:
 *   forge doctor
 *   forge doctor --json
 *   forge doctor --install
 *   forge doctor --warn-only   # always exit 0 (for forge:new)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OPENSPEC_PACKAGE,
  OPENSPEC_INSTALL_CMD,
  resolveProjectPlanEngine,
} from './plan-engine.mjs';
import { ensureClaudeHookHints } from './init.mjs';
import { collectHookCommands, isCommandReferenced } from './hooks.mjs';

export { OPENSPEC_PACKAGE, OPENSPEC_INSTALL_CMD };

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    json: false,
    install: false,
    warnOnly: false,
    cwd: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--install') opts.install = true;
    else if (arg === '--warn-only') opts.warnOnly = true;
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--') continue;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`Usage: forge doctor [options]

Check planning-engine readiness. OpenSpec projects: config + CLI availability.
Specs-engine projects (.forge/config.json → plan.engine: specs):
\`<plan.dir>/changes/\` + \`<plan.dir>/specs/\` layout.

Options:
  --json        Machine-readable report
  --install     Attempt: ${OPENSPEC_INSTALL_CMD}
  --warn-only   Print warnings but exit 0 (used by forge:new)
  --cwd <path>  Project root (default: process.cwd())
  --help
`);
}

/**
 * @param {{ cwd: string, existsSync?: typeof fs.existsSync }} opts
 */
export function checkOpenSpecProject(opts) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  const configPath = path.join(opts.cwd, 'openspec', 'config.yaml');
  const ok = existsSync(configPath);
  return {
    id: 'openspec-project',
    ok,
    configPath,
    message: ok
      ? 'openspec/config.yaml found'
      : 'openspec/config.yaml missing — run openspec init in the repo root if this is a new project',
  };
}

/**
 * @param {{
 *   runCommand?: (cmd: string, args: string[], opts?: { cwd?: string }) => { status: number | null, stdout: string, stderr: string },
 *   cwd?: string,
 * }} [opts]
 */
export function checkOpenSpecCli(opts = {}) {
  const run =
    opts.runCommand ??
    ((cmd, args, runOpts = {}) => {
      // Prefer argv form without shell. On Windows, fall back to a single
      // shell string so `.cmd` shims resolve without DEP0190 (args+shell).
      let result = spawnSync(cmd, args, {
        encoding: 'utf8',
        shell: false,
        cwd: runOpts.cwd,
      });
      if (result.error && process.platform === 'win32') {
        const line = [cmd, ...args].join(' ');
        result = spawnSync(line, {
          encoding: 'utf8',
          shell: true,
          cwd: runOpts.cwd,
        });
      }
      return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error,
      };
    });

  const attempt = run('openspec', ['--version'], { cwd: opts.cwd });
  if (attempt.status === 0) {
    const version = String(attempt.stdout || '').trim().split(/\r?\n/)[0] || 'unknown';
    return {
      id: 'openspec-cli',
      ok: true,
      version,
      message: `openspec CLI available (${version})`,
      installCommand: OPENSPEC_INSTALL_CMD,
    };
  }

  return {
    id: 'openspec-cli',
    ok: false,
    version: null,
    message:
      `openspec CLI not found on PATH. Install with:\n  ${OPENSPEC_INSTALL_CMD}\n` +
      `Then re-run: forge doctor`,
    installCommand: OPENSPEC_INSTALL_CMD,
    detail: String(attempt.stderr || attempt.stdout || attempt.error || '').trim() || null,
  };
}

/**
 * @param {{ cwd: string, dir: string, existsSync?: typeof fs.existsSync }} opts
 */
export function checkSpecsProject(opts) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  const changesPath = path.join(opts.cwd, opts.dir, 'changes');
  const specsPath = path.join(opts.cwd, opts.dir, 'specs');
  const changesOk = existsSync(changesPath);
  const specsOk = existsSync(specsPath);
  const ok = changesOk && specsOk;
  const missing = [
    !changesOk ? `${opts.dir}/changes/` : null,
    !specsOk ? `${opts.dir}/specs/` : null,
  ].filter(Boolean);
  return {
    id: 'specs-project',
    ok,
    changesPath,
    specsPath,
    message: ok
      ? `${opts.dir}/changes/ + ${opts.dir}/specs/ found (built-in specs engine)`
      : `${missing.join(' + ')} missing — run \`forge init --no-openspec\` (optionally \`--plan-dir ${opts.dir}\`) to scaffold`,
  };
}

const FORGE_HOOK_FILE_RE = /^forge-.*\.mjs$/;

/**
 * Detect forge hook files on disk that are not referenced by the host
 * surface's wiring (settings.json / settings.local.json for Claude,
 * hooks.json for Cursor). Does not integrate into runDoctorChecks.
 * @param {{
 *   cwd: string,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   readdirSync?: typeof fs.readdirSync,
 * }} opts
 */
export function checkHookWiring(opts) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  const readFileSync = opts.readFileSync ?? fs.readFileSync;
  const readdirSync = opts.readdirSync ?? fs.readdirSync;
  const cwd = opts.cwd;

  const surfaceDefs = [
    {
      surface: 'claude',
      hooksDir: path.join(cwd, '.claude', 'hooks'),
      wiringPaths: [
        path.join(cwd, '.claude', 'settings.json'),
        path.join(cwd, '.claude', 'settings.local.json'),
      ],
      hint: 'merge .claude/forge-hooks.snippet.json into .claude/settings.json',
    },
    {
      surface: 'cursor',
      hooksDir: path.join(cwd, '.cursor', 'hooks'),
      wiringPaths: [path.join(cwd, '.cursor', 'hooks.json')],
      hint: 'merge .cursor/forge-hooks.snippet.json into .cursor/hooks.json',
    },
  ];

  const surfaces = [];

  for (const def of surfaceDefs) {
    if (!existsSync(def.hooksDir)) continue;

    let entries;
    try {
      entries = readdirSync(def.hooksDir);
    } catch {
      entries = [];
    }
    const present = entries.filter((name) => FORGE_HOOK_FILE_RE.test(name));
    if (present.length === 0) continue;

    const wiringPaths = def.wiringPaths.filter((p) => existsSync(p));
    const references = new Set();
    const errors = [];

    for (const wiringPath of wiringPaths) {
      let raw;
      try {
        raw = readFileSync(wiringPath, 'utf8');
      } catch (err) {
        errors.push(`${wiringPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        errors.push(`${wiringPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      collectHookCommands(json?.hooks, references);
    }

    const unwired = present.filter((name) => !isCommandReferenced(name, references));
    const wiringError = errors.length > 0 ? errors.join('; ') : null;
    const surfaceOk = unwired.length === 0;

    surfaces.push({
      surface: def.surface,
      hooksDir: def.hooksDir,
      wiringPaths,
      present,
      unwired,
      wiringError,
      ok: surfaceOk,
      hint: def.hint,
    });
  }

  const ok = surfaces.every((s) => s.ok);
  const skipped = surfaces.length === 0;

  let message;
  if (skipped) {
    message = 'no forge hooks found on disk';
  } else if (ok) {
    message = 'forge hooks wired';
  } else {
    message = surfaces
      .filter((s) => !s.ok)
      .map((s) => {
        const names = s.unwired.join(', ');
        const errPart = s.wiringError ? ` (${s.wiringError})` : '';
        return `${s.surface}: unwired hook(s) ${names}${errPart} — ${s.hint}`;
      })
      .join('; ');
  }

  return {
    id: 'hook-wiring',
    ok,
    skipped,
    surfaces: surfaces.map(({ hint, ...rest }) => rest),
    message,
  };
}

/**
 * `forge doctor --install`'s hook-repair step: when the claude surface is
 * unwired, merge the standard hooks snippet into `.claude/settings.json` —
 * the same structural merge `forge init` performs (writes the snippet file
 * too, for transparency). Cursor's `hooks.json` merge already happens inside
 * `forge init` and is out of scope for `--install`.
 * @param {string} cwd
 * @param {ReturnType<typeof checkHookWiring>} hooks
 * @returns {boolean} whether a repair was attempted
 */
function installUnwiredClaudeHooks(cwd, hooks) {
  const claude = hooks.surfaces.find((s) => s.surface === 'claude');
  if (!claude || claude.ok) return false;
  ensureClaudeHookHints(cwd, { force: false });
  return true;
}

/**
 * @param {{
 *   cwd?: string,
 *   install?: boolean,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   runCommand?: Function,
 * }} [opts]
 */
export function runDoctorChecks(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const engine = resolveProjectPlanEngine(cwd, { useUserDefault: false });

  if (engine.engine === 'specs') {
    const project = checkSpecsProject({
      cwd,
      dir: engine.dir,
      existsSync: opts.existsSync,
    });
    const cli = {
      id: 'openspec-cli',
      ok: true,
      skipped: true,
      version: null,
      message: 'built-in specs engine — OpenSpec CLI not required',
      installCommand: OPENSPEC_INSTALL_CMD,
    };
    let hooks = checkHookWiring({
      cwd,
      existsSync: opts.existsSync,
      readFileSync: opts.readFileSync,
      readdirSync: opts.readdirSync,
    });
    if (opts.install && !hooks.ok && installUnwiredClaudeHooks(cwd, hooks)) {
      hooks = checkHookWiring({
        cwd,
        existsSync: opts.existsSync,
        readFileSync: opts.readFileSync,
        readdirSync: opts.readdirSync,
      });
    }
    return {
      ok: project.ok && cli.ok && hooks.ok,
      engine: engine.engine,
      checks: { project, cli, hooks },
      installCommand: OPENSPEC_INSTALL_CMD,
      actions: [],
    };
  }

  const project = checkOpenSpecProject({ cwd, existsSync: opts.existsSync });
  let cli = checkOpenSpecCli({ cwd, runCommand: opts.runCommand });

  /** @type {string[]} */
  const actions = [];

  if (opts.install && !cli.ok) {
    actions.push(OPENSPEC_INSTALL_CMD);
    const run =
      opts.runCommand ??
      ((cmd, args) => {
        let result = spawnSync(cmd, args, {
          encoding: 'utf8',
          shell: false,
          cwd,
        });
        if (result.error && process.platform === 'win32') {
          result = spawnSync([cmd, ...args].join(' '), {
            encoding: 'utf8',
            shell: true,
            cwd,
          });
        }
        return {
          status: result.status,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          error: result.error,
        };
      });
    const installResult = run('npm', ['install', '-g', OPENSPEC_PACKAGE], { cwd });
    actions.push(
      installResult.status === 0
        ? 'install: ok'
        : `install: failed (${String(installResult.stderr || installResult.stdout || '').trim() || installResult.status})`,
    );
    cli = checkOpenSpecCli({ cwd, runCommand: opts.runCommand });
  }

  let hooks = checkHookWiring({
    cwd,
    existsSync: opts.existsSync,
    readFileSync: opts.readFileSync,
    readdirSync: opts.readdirSync,
  });
  if (opts.install && !hooks.ok && installUnwiredClaudeHooks(cwd, hooks)) {
    hooks = checkHookWiring({
      cwd,
      existsSync: opts.existsSync,
      readFileSync: opts.readFileSync,
      readdirSync: opts.readdirSync,
    });
  }

  const ok = project.ok && cli.ok && hooks.ok;
  return {
    ok,
    engine: engine.engine,
    checks: { project, cli, hooks },
    installCommand: OPENSPEC_INSTALL_CMD,
    actions,
  };
}

/**
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   runCommand?: Function,
 * }} [io]
 */
export function runDoctor(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`${msg}\n`);
    return 2;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  const report = runDoctorChecks({
    cwd: opts.cwd ?? cwd,
    install: opts.install,
    existsSync: io.existsSync,
    readFileSync: io.readFileSync,
    readdirSync: io.readdirSync,
    runCommand: io.runCommand,
  });

  if (opts.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const { project, cli, hooks } = report.checks;
    stdout.write(`Forge doctor (plan engine: ${report.engine ?? 'openspec'})\n`);
    stdout.write(`  [${project.ok ? 'ok' : 'FAIL'}] ${project.message}\n`);
    stdout.write(`  [${cli.ok ? 'ok' : 'FAIL'}] ${cli.message}\n`);
    stdout.write(`  [${hooks.ok ? 'ok' : 'FAIL'}] ${hooks.message}\n`);
    if (!cli.ok) {
      stdout.write(`\nOffer: install OpenSpec CLI?\n  ${cli.installCommand}\n`);
      stdout.write(`Or re-run with: forge doctor --install\n`);
    }
    for (const action of report.actions) {
      stdout.write(`  action: ${action}\n`);
    }
    stdout.write(report.ok ? '\nAll checks passed.\n' : '\nDoctor found issues.\n');
  }

  if (opts.warnOnly) return 0;
  return report.ok ? 0 : 1;
}

/**
 * Warn-only helper for forge:new (never throws).
 * @param {{
 *   cwd?: string,
 *   stderr?: NodeJS.WritableStream,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   runCommand?: Function,
 * }} [opts]
 */
export function warnIfDoctorFails(opts = {}) {
  const stderr = opts.stderr ?? process.stderr;
  try {
    const report = runDoctorChecks({
      cwd: opts.cwd ?? process.cwd(),
      existsSync: opts.existsSync,
      readFileSync: opts.readFileSync,
      readdirSync: opts.readdirSync,
      runCommand: opts.runCommand,
    });
    if (!report.ok) {
      stderr.write('[forge:doctor] plan-engine readiness check failed:\n');
      if (!report.checks.project.ok) {
        stderr.write(`  - ${report.checks.project.message}\n`);
      }
      if (!report.checks.cli.ok) {
        stderr.write(`  - ${report.checks.cli.message}\n`);
      }
      if (report.checks.hooks && !report.checks.hooks.ok) {
        stderr.write(`  - ${report.checks.hooks.message}\n`);
      }
      if (!report.checks.cli.ok) {
        stderr.write(`  Install: ${report.installCommand}\n`);
        stderr.write('  Or: forge doctor --install\n');
      }
    }
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[forge:doctor] check error: ${msg}\n`);
    return null;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = runDoctor(process.argv.slice(2));
}
