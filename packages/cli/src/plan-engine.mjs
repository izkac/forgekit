#!/usr/bin/env node
/**
 * Planning engine resolution + scaffolding for forgekit.
 *
 * Engines:
 *   openspec — vendor OpenSpec CLI (`openspec/changes/<name>/`)
 *   specs    — built-in markdown engine (`specs/changes/<name>/`), same inner
 *              layout as OpenSpec so phases / archive→ADR / later migration
 *              stay compatible.
 *
 * User default:  ~/.forgekit/config.json  → { plan: { engine } }
 * Project:       <repo>/.forge/config.json → { plan: { engine, dir } }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadProjectConfig,
  loadUserConfig,
  saveProjectConfig,
  saveUserConfig,
} from './config.mjs';

export const PLAN_ENGINES = Object.freeze(['openspec', 'specs']);
export const DEFAULT_SPECS_DIR = 'specs';

export const OPENSPEC_PACKAGE = '@fission-ai/openspec';
export const OPENSPEC_INSTALL_CMD = `npm install -g ${OPENSPEC_PACKAGE}`;

/**
 * @param {unknown} value
 * @returns {{ engine?: string, dir?: string } | null}
 */
function asPlan(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {{ engine?: string, dir?: string }} */ (value);
}

/**
 * @param {string} engine
 */
export function assertPlanEngine(engine) {
  if (!PLAN_ENGINES.includes(engine)) {
    throw new Error(`Unknown plan engine: ${engine}. Known: ${PLAN_ENGINES.join(', ')}`);
  }
  return engine;
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
export function hasOpenSpecConfig(cwd) {
  return fs.existsSync(path.join(cwd, 'openspec', 'config.yaml'));
}

/**
 * @param {string} [home]
 * @returns {string | null}
 */
export function loadUserPlanEngine(home = os.homedir()) {
  const cfg = loadUserConfig(home);
  const engine = asPlan(cfg.plan)?.engine;
  return PLAN_ENGINES.includes(engine) ? engine : null;
}

/**
 * Merge { plan: { engine } } into ~/.forgekit/config.json, preserving other keys.
 * @param {string} engine
 * @param {string} [home]
 */
export function saveUserPlanEngine(engine, home = os.homedir()) {
  assertPlanEngine(engine);
  return saveUserConfig({ plan: { engine } }, home);
}

/**
 * Merge { plan: { engine, dir? } } into <cwd>/.forge/config.json, preserving adr etc.
 * @param {string} cwd
 * @param {{ engine: string, dir?: string }} plan
 */
export function writeProjectPlanConfig(cwd, plan) {
  assertPlanEngine(plan.engine);
  const current = loadProjectConfig(cwd);
  const curPlan = asPlan(current.plan);
  /** @type {{ engine: string, dir?: string }} */
  const nextPlan = { engine: plan.engine };
  if (plan.engine === 'specs') {
    nextPlan.dir = plan.dir ?? curPlan?.dir ?? DEFAULT_SPECS_DIR;
  }
  return saveProjectConfig(cwd, { plan: nextPlan }, { replaceKeys: ['plan'] });
}

/**
 * Effective plan engine for a project.
 *
 * Precedence: project config → openspec/config.yaml detection → user default
 * → 'openspec'.
 *
 * @param {string} cwd
 * @param {{ home?: string, useUserDefault?: boolean }} [opts]
 * @returns {{ engine: string, dir: string, source: string }}
 */
export function resolveProjectPlanEngine(cwd, opts = {}) {
  const project = loadProjectConfig(cwd);
  const projectPlan = asPlan(project.plan);
  if (projectPlan && PLAN_ENGINES.includes(projectPlan.engine)) {
    return {
      engine: /** @type {string} */ (projectPlan.engine),
      dir: projectPlan.dir ?? DEFAULT_SPECS_DIR,
      source: 'project',
    };
  }
  if (hasOpenSpecConfig(cwd)) {
    return { engine: 'openspec', dir: DEFAULT_SPECS_DIR, source: 'detected' };
  }
  if (opts.useUserDefault !== false) {
    const userEngine = loadUserPlanEngine(opts.home);
    if (userEngine) {
      return { engine: userEngine, dir: DEFAULT_SPECS_DIR, source: 'user' };
    }
  }
  return { engine: 'openspec', dir: DEFAULT_SPECS_DIR, source: 'default' };
}

const SPECS_README = (dir) => `# \`${dir}/\` — Forge specs (built-in planning engine)

OpenSpec-compatible change tracking without the OpenSpec CLI. Managed by the
Forge workflow (see the \`forge\` skill, \`phases/plan-specs.md\`).

\`\`\`
${dir}/
  changes/<change-name>/
    proposal.md   # Why / What Changes / Impact
    design.md     # optional — context, decisions, risks
    tasks.md      # ## groups with - [ ] task checkboxes
  changes/archive/YYYY-MM-DD-<change-name>/   # archived on finish
\`\`\`

Conventions (kept identical to OpenSpec so migration stays trivial):

- One change per unit of substantial work; kebab-case change names.
- \`tasks.md\` uses \`##\` section groups and \`- [ ]\` checkboxes; Forge counts
  and reviews per group.
- On finish, move the change dir into \`changes/archive/\` with a date prefix,
  then follow the project ADR policy if enabled.

Migrating to OpenSpec later: run \`openspec init\`, then move
\`${dir}/changes/*\` into \`openspec/changes/\`.
`;

/**
 * Scaffold the specs engine directory structure.
 * @param {string} cwd
 * @param {{ dir?: string, force?: boolean }} [opts]
 */
export function scaffoldSpecs(cwd, opts = {}) {
  const dir = opts.dir ?? DEFAULT_SPECS_DIR;
  /** @type {{ file: string, status: string }[]} */
  const files = [];

  const ensureDir = (rel) => {
    fs.mkdirSync(path.join(cwd, ...rel.split('/')), { recursive: true });
  };
  const writeFile = (rel, body) => {
    const dest = path.join(cwd, ...rel.split('/'));
    if (fs.existsSync(dest) && !opts.force) {
      files.push({ file: rel, status: 'skipped' });
      return;
    }
    fs.writeFileSync(dest, body, 'utf8');
    files.push({ file: rel, status: 'written' });
  };

  ensureDir(`${dir}/changes/archive`);
  writeFile(`${dir}/README.md`, SPECS_README(dir));
  writeFile(`${dir}/changes/archive/.gitkeep`, '');

  return { dir, files };
}

/**
 * @returns {{ ok: boolean, version: string | null }}
 */
export function checkOpenSpecCliQuick(runCommand) {
  const run =
    runCommand ??
    ((cmd, args) => {
      let result = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
      if (result.error && process.platform === 'win32') {
        result = spawnSync([cmd, ...args].join(' '), { encoding: 'utf8', shell: true });
      }
      return { status: result.status, stdout: result.stdout || '' };
    });
  const attempt = run('openspec', ['--version']);
  if (attempt.status === 0) {
    return {
      ok: true,
      version: String(attempt.stdout || '').trim().split(/\r?\n/)[0] || 'unknown',
    };
  }
  return { ok: false, version: null };
}

/**
 * Install the OpenSpec CLI (if missing) and run `openspec init` in the project.
 * Interactive: inherits stdio so `openspec init` can prompt.
 *
 * @param {string} cwd
 * @param {{ runCommand?: Function, interactive?: boolean }} [opts]
 * @returns {{ ok: boolean, steps: { step: string, ok: boolean, detail?: string }[] }}
 */
export function setupOpenSpec(cwd, opts = {}) {
  /** @type {{ step: string, ok: boolean, detail?: string }[]} */
  const steps = [];

  const runInherit =
    opts.runCommand ??
    ((cmd, args) => {
      let result = spawnSync(cmd, args, { stdio: 'inherit', shell: false, cwd });
      if (result.error && process.platform === 'win32') {
        result = spawnSync([cmd, ...args].join(' '), {
          stdio: 'inherit',
          shell: true,
          cwd,
        });
      }
      return { status: result.status, error: result.error };
    });

  const cli = checkOpenSpecCliQuick(opts.runCommand);
  if (!cli.ok) {
    const install = runInherit('npm', ['install', '-g', OPENSPEC_PACKAGE]);
    const ok = install.status === 0;
    steps.push({
      step: OPENSPEC_INSTALL_CMD,
      ok,
      detail: ok ? undefined : String(install.error ?? `exit ${install.status}`),
    });
    if (!ok) return { ok: false, steps };
  } else {
    steps.push({ step: `openspec CLI present (${cli.version})`, ok: true });
  }

  if (hasOpenSpecConfig(cwd)) {
    steps.push({ step: 'openspec/config.yaml already present', ok: true });
    return { ok: true, steps };
  }

  const init = runInherit('openspec', ['init']);
  const initOk = init.status === 0;
  steps.push({
    step: 'openspec init',
    ok: initOk,
    detail: initOk ? undefined : String(init.error ?? `exit ${init.status}`),
  });
  return { ok: initOk && hasOpenSpecConfig(cwd), steps };
}
