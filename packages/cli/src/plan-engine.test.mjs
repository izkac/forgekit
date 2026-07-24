import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SPECS_DIR,
  DEFAULT_OPENSPEC_DIR,
  PLAN_ENGINES,
  hasOpenSpecConfig,
  loadUserPlanEngine,
  normalizePlanDir,
  resolveProjectPlanEngine,
  saveUserPlanEngine,
  scaffoldSpecs,
  setupOpenSpec,
  toOpenSpecToolIds,
  writeProjectPlanConfig,
} from './plan-engine.mjs';
import { loadProjectConfig, loadUserConfig, saveUserConfig } from './adr.mjs';
import { parseArgs as parseInstallArgs } from './install.mjs';
import {
  parseArgs as parseInitArgs,
  initProject,
  resolveInitPlanEngine,
} from './init.mjs';
import { runDoctorChecks } from './doctor.mjs';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('user plan engine round-trip preserves adr config', () => {
  const home = tmpdir('forgekit-plan-user-');
  try {
    saveUserConfig({ adr: { enabled: true, dir: 'docs/adr' } }, home);
    saveUserPlanEngine('specs', home);
    assert.equal(loadUserPlanEngine(home), 'specs');
    assert.equal(loadUserConfig(home).adr.enabled, true);
    saveUserPlanEngine('openspec', home);
    assert.equal(loadUserPlanEngine(home), 'openspec');
    assert.throws(() => saveUserPlanEngine('bogus', home), /Unknown plan engine/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeProjectPlanConfig preserves adr block and sets dir for specs', () => {
  const cwd = tmpdir('forgekit-plan-proj-');
  try {
    fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      JSON.stringify({ adr: { enabled: true, dir: 'docs/adr' } }),
      'utf8',
    );
    writeProjectPlanConfig(cwd, { engine: 'specs' });
    const cfg = loadProjectConfig(cwd);
    assert.equal(cfg.plan.engine, 'specs');
    assert.equal(cfg.plan.dir, DEFAULT_SPECS_DIR);
    assert.equal(cfg.adr.enabled, true);

    writeProjectPlanConfig(cwd, { engine: 'openspec' });
    assert.equal(loadProjectConfig(cwd).plan.engine, 'openspec');
    assert.equal(loadProjectConfig(cwd).plan.dir, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveProjectPlanEngine precedence: project > detection > user > default', () => {
  const cwd = tmpdir('forgekit-plan-res-');
  const home = tmpdir('forgekit-plan-res-home-');
  try {
    // default
    assert.equal(
      resolveProjectPlanEngine(cwd, { home }).engine,
      'openspec',
    );
    assert.equal(resolveProjectPlanEngine(cwd, { home }).dir, DEFAULT_OPENSPEC_DIR);
    assert.equal(resolveProjectPlanEngine(cwd, { home }).source, 'default');

    // user default
    saveUserPlanEngine('specs', home);
    const viaUser = resolveProjectPlanEngine(cwd, { home });
    assert.equal(viaUser.engine, 'specs');
    assert.equal(viaUser.dir, DEFAULT_SPECS_DIR);
    assert.equal(viaUser.source, 'user');

    // useUserDefault=false ignores user config
    assert.equal(
      resolveProjectPlanEngine(cwd, { home, useUserDefault: false }).source,
      'default',
    );

    // openspec detection beats user default
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'name: x\n', 'utf8');
    assert.equal(hasOpenSpecConfig(cwd), true);
    const detected = resolveProjectPlanEngine(cwd, { home });
    assert.equal(detected.engine, 'openspec');
    assert.equal(detected.dir, DEFAULT_OPENSPEC_DIR);
    assert.equal(detected.source, 'detected');

    // project config beats detection
    writeProjectPlanConfig(cwd, { engine: 'specs', dir: 'specs' });
    const viaProject = resolveProjectPlanEngine(cwd, { home });
    assert.equal(viaProject.engine, 'specs');
    assert.equal(viaProject.source, 'project');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('normalizePlanDir rejects absolute and parent paths', () => {
  assert.equal(normalizePlanDir('openspec'), 'openspec');
  assert.equal(normalizePlanDir('./specs/'), 'specs');
  assert.throws(() => normalizePlanDir('/tmp/x'), /relative/);
  assert.throws(() => normalizePlanDir('../x'), /relative/);
  assert.throws(() => normalizePlanDir(''), /non-empty/);
});

test('scaffoldSpecs writes README + changes/archive + main specs catalog', () => {
  const cwd = tmpdir('forgekit-specs-scaffold-');
  try {
    const result = scaffoldSpecs(cwd, { force: true });
    assert.equal(result.dir, DEFAULT_SPECS_DIR);
    assert.ok(fs.existsSync(path.join(cwd, 'specs', 'README.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'specs', 'changes', 'archive')));
    assert.ok(fs.existsSync(path.join(cwd, 'specs', 'specs', '.gitkeep')));
    const readme = fs.readFileSync(path.join(cwd, 'specs', 'README.md'), 'utf8');
    assert.match(readme, /changes\/<change-name>/);
    assert.match(readme, /tasks\.md/);
    assert.match(readme, /ADDED \/ MODIFIED \/ REMOVED/);

    // second run without force skips
    const again = scaffoldSpecs(cwd);
    assert.ok(again.files.some((f) => f.status === 'skipped'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('scaffoldSpecs + init honor custom plan.dir (e.g. openspec)', () => {
  const cwd = tmpdir('forgekit-plan-dir-');
  try {
    const report = initProject(['codex'], {
      cwd,
      force: true,
      planEngine: 'specs',
      planDir: 'openspec',
    });
    assert.equal(report.plan.engine, 'specs');
    assert.equal(report.plan.dir, 'openspec');
    assert.equal(loadProjectConfig(cwd).plan.dir, 'openspec');
    assert.ok(fs.existsSync(path.join(cwd, 'openspec', 'changes')));
    assert.ok(fs.existsSync(path.join(cwd, 'openspec', 'specs')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init parseArgs --plan-dir', () => {
  assert.equal(parseInitArgs(['--plan-dir', 'openspec']).planDir, 'openspec');
  assert.equal(parseInitArgs([]).planDir, null);
});

test('setupOpenSpec runs install + init via injected runner', () => {
  const cwd = tmpdir('forgekit-openspec-setup-');
  try {
    /** @type {string[]} */
    const calls = [];
    const runCommand = (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (line === 'openspec --version') return { status: 1, stdout: '' };
      if (line.startsWith('npm install -g')) return { status: 0, stdout: '' };
      if (line === 'openspec init') {
        fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n', 'utf8');
        return { status: 0, stdout: '' };
      }
      return { status: 1, stdout: '' };
    };
    const result = setupOpenSpec(cwd, { runCommand });
    assert.equal(result.ok, true);
    assert.ok(calls.some((c) => c.startsWith('npm install -g')));
    assert.ok(calls.includes('openspec init'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('toOpenSpecToolIds maps copilot → github-copilot, else identity', () => {
  assert.deepEqual(
    toOpenSpecToolIds(['claude', 'cursor', 'codex', 'opencode', 'copilot', 'gemini', 'windsurf']),
    ['claude', 'cursor', 'codex', 'opencode', 'github-copilot', 'gemini', 'windsurf'],
  );
});

test('setupOpenSpec passes selected tools to `openspec init --tools`', () => {
  const cwd = tmpdir('forgekit-openspec-tools-');
  try {
    /** @type {string[]} */
    const calls = [];
    const runCommand = (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (line === 'openspec --version') return { status: 0, stdout: '1.0.0' };
      if (line.startsWith('openspec init')) {
        fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n', 'utf8');
        return { status: 0, stdout: '' };
      }
      return { status: 1, stdout: '' };
    };
    const result = setupOpenSpec(cwd, {
      runCommand,
      tools: ['claude', 'cursor', 'codex', 'copilot'],
    });
    assert.equal(result.ok, true);
    assert.ok(
      calls.includes('openspec init --tools claude,cursor,codex,github-copilot'),
      `expected --tools call, got: ${calls.join(' | ')}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('setupOpenSpec reports failure when install fails', () => {
  const cwd = tmpdir('forgekit-openspec-fail-');
  try {
    const runCommand = () => ({ status: 1, stdout: '' });
    const result = setupOpenSpec(cwd, { runCommand });
    assert.equal(result.ok, false);
    assert.ok(result.steps.some((s) => !s.ok));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('install parseArgs --openspec / --no-openspec', () => {
  assert.equal(parseInstallArgs(['--openspec']).openspec, true);
  assert.equal(parseInstallArgs(['--no-openspec']).openspec, false);
  assert.equal(parseInstallArgs([]).openspec, null);
});

test('init parseArgs --openspec / --no-openspec', () => {
  assert.equal(parseInitArgs(['--openspec']).openspec, true);
  assert.equal(parseInitArgs(['--no-openspec']).openspec, false);
  assert.equal(parseInitArgs([]).openspec, null);
});

test('initProject planEngine=specs scaffolds and writes config', () => {
  const cwd = tmpdir('forgekit-init-specs-');
  try {
    const report = initProject(['codex'], {
      cwd,
      force: true,
      planEngine: 'specs',
    });
    assert.equal(report.plan.engine, 'specs');
    assert.ok(fs.existsSync(path.join(cwd, 'specs', 'README.md')));
    assert.equal(loadProjectConfig(cwd).plan.engine, 'specs');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject planEngine=openspec records engine without scaffolding specs', () => {
  const cwd = tmpdir('forgekit-init-os-');
  try {
    const report = initProject(['codex'], {
      cwd,
      force: true,
      planEngine: 'openspec',
    });
    assert.equal(report.plan.engine, 'openspec');
    assert.equal(report.plan.configured, false);
    assert.ok(!fs.existsSync(path.join(cwd, 'specs')));
    assert.equal(loadProjectConfig(cwd).plan.engine, 'openspec');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: setup failure keeps openspec (no specs fallback)', async () => {
  const cwd = tmpdir('forgekit-resolve-fail-');
  try {
    const engine = await resolveInitPlanEngine({
      cwd,
      openspec: null,
      isTTY: true,
      loadUser: () => 'openspec',
      confirmSetup: async () => true,
      setup: () => ({
        ok: false,
        steps: [{ step: 'openspec init', ok: false, detail: 'exit 1' }],
      }),
    });
    assert.equal(engine, 'openspec');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: declining setup keeps openspec when user default is openspec', async () => {
  const cwd = tmpdir('forgekit-resolve-decline-');
  try {
    const engine = await resolveInitPlanEngine({
      cwd,
      openspec: null,
      isTTY: true,
      loadUser: () => 'openspec',
      confirmSetup: async () => false,
      setup: () => {
        throw new Error('setup should not run when declined');
      },
    });
    assert.equal(engine, 'openspec');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: --openspec keeps openspec even when setup fails', async () => {
  const cwd = tmpdir('forgekit-resolve-flag-');
  try {
    const engine = await resolveInitPlanEngine({
      cwd,
      openspec: true,
      isTTY: true,
      setup: () => ({
        ok: false,
        steps: [{ step: 'openspec init', ok: false }],
      }),
    });
    assert.equal(engine, 'openspec');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: interactive engine pick openspec survives setup failure', async () => {
  const cwd = tmpdir('forgekit-resolve-pick-');
  try {
    const engine = await resolveInitPlanEngine({
      cwd,
      openspec: null,
      isTTY: true,
      loadUser: () => null,
      promptEngine: async () => true,
      confirmSetup: async () => true,
      setup: () => ({
        ok: false,
        steps: [{ step: 'openspec init', ok: false }],
      }),
    });
    assert.equal(engine, 'openspec');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: interactive engine pick specs skips setup', async () => {
  const cwd = tmpdir('forgekit-resolve-specs-pick-');
  try {
    const engine = await resolveInitPlanEngine({
      cwd,
      openspec: null,
      isTTY: true,
      loadUser: () => null,
      promptEngine: async () => false,
      setup: () => {
        throw new Error('setup should not run for specs');
      },
    });
    assert.equal(engine, 'specs');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: --no-openspec and user specs default', async () => {
  const cwd = tmpdir('forgekit-resolve-no-');
  try {
    assert.equal(
      await resolveInitPlanEngine({ cwd, openspec: false, isTTY: true }),
      'specs',
    );
    assert.equal(
      await resolveInitPlanEngine({
        cwd,
        openspec: null,
        isTTY: true,
        loadUser: () => 'specs',
        promptEngine: async () => {
          throw new Error('should not ask when user default is specs');
        },
      }),
      'specs',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor: specs engine checks specs layout instead of OpenSpec CLI', () => {
  const cwd = tmpdir('forgekit-doctor-specs-');
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs' });

    const missing = runDoctorChecks({ cwd });
    assert.equal(missing.engine, 'specs');
    assert.equal(missing.ok, false);
    assert.match(missing.checks.project.message, /specs\/changes/);
    assert.equal(missing.checks.cli.ok, true);
    assert.equal(missing.checks.cli.skipped, true);

    scaffoldSpecs(cwd);
    const present = runDoctorChecks({ cwd });
    assert.equal(present.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor: openspec engine unchanged for openspec projects', () => {
  const cwd = tmpdir('forgekit-doctor-os-');
  try {
    const report = runDoctorChecks({
      cwd,
      existsSync: () => true,
      runCommand: () => ({ status: 0, stdout: '1.0.0', stderr: '' }),
    });
    assert.equal(report.engine, 'openspec');
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('PLAN_ENGINES is the closed engine set', () => {
  assert.deepEqual([...PLAN_ENGINES], ['openspec', 'specs']);
});
