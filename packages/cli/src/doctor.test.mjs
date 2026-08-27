import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OPENSPEC_INSTALL_CMD,
  checkHookWiring,
  checkOpenSpecCli,
  checkOpenSpecProject,
  runDoctor,
  runDoctorChecks,
  warnIfDoctorFails,
} from './doctor.mjs';
import { FORGEKIT_STAMP, installSkillsToAgents } from './install.mjs';

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-hook-wiring-'));
}

function writeHookFiles(cwd, dirParts, names) {
  const dir = path.join(cwd, ...dirParts);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '// stub hook\n');
  }
  return dir;
}

function writeJsonFile(cwd, relParts, data) {
  const filePath = path.join(cwd, ...relParts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, text: () => text };
}

test('checkOpenSpecProject ok when config exists', () => {
  const result = checkOpenSpecProject({
    cwd: '/repo',
    existsSync: (p) => p.replace(/\\/g, '/') === '/repo/openspec/config.yaml',
  });
  assert.equal(result.ok, true);
});

test('checkOpenSpecProject fails when missing', () => {
  const result = checkOpenSpecProject({
    cwd: '/repo',
    existsSync: () => false,
  });
  assert.equal(result.ok, false);
});

test('checkOpenSpecCli ok when version exits 0', () => {
  const result = checkOpenSpecCli({
    runCommand: () => ({ status: 0, stdout: '1.2.0\n', stderr: '' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.0');
});

test('checkOpenSpecCli missing offers install', () => {
  const result = checkOpenSpecCli({
    runCommand: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /@fission-ai\/openspec/);
  assert.equal(result.installCommand, OPENSPEC_INSTALL_CMD);
});

test('runDoctorChecks aggregates', () => {
  const report = runDoctorChecks({
    cwd: '/repo',
    existsSync: () => true,
    // existsSync claims the hooks dirs exist, so the check will read them;
    // an empty listing means "no forge hooks on disk" (skipped), not a
    // read failure (F76).
    readdirSync: () => [],
    runCommand: () => ({ status: 0, stdout: '1.0.0', stderr: '' }),
  });
  assert.equal(report.ok, true);
});

test('runDoctor --warn-only exits 0 on failure', () => {
  const out = capture();
  const err = capture();
  const code = runDoctor(['--warn-only'], {
    cwd: '/repo',
    stdout: out.stream,
    stderr: err.stream,
    existsSync: () => true,
    runCommand: () => ({ status: 1, stdout: '', stderr: 'missing' }),
  });
  assert.equal(code, 0);
  assert.match(out.text(), /FAIL|not found|Install/i);
});

test('runDoctor exits 1 when CLI missing', () => {
  const out = capture();
  const err = capture();
  const code = runDoctor([], {
    cwd: '/repo',
    stdout: out.stream,
    stderr: err.stream,
    existsSync: () => true,
    runCommand: () => ({ status: 1, stdout: '', stderr: 'missing' }),
  });
  assert.equal(code, 1);
  assert.match(out.text(), /npm install -g @fission-ai\/openspec/);
});

test('warnIfDoctorFails writes to stderr', () => {
  const err = capture();
  const report = warnIfDoctorFails({
    cwd: '/repo',
    stderr: err.stream,
    existsSync: () => false,
    runCommand: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  assert.equal(report.ok, false);
  assert.match(err.text(), /forge:doctor/);
  assert.match(err.text(), /install/i);
});

test('checkHookWiring: no hooks dirs on disk -> ok with skipped true', () => {
  const cwd = makeTempProject();
  try {
    const result = checkHookWiring({ cwd });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.surfaces, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: forge hooks present but settings.json references none -> fails, lists all', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-model-hook.mjs', 'forge-session-start.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    writeJsonFile(cwd, ['.claude', 'settings.json'], {
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/eslint-changed.mjs"',
              },
            ],
          },
        ],
      },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.ok(claude);
    assert.equal(claude.ok, false);
    assert.deepEqual(claude.present.slice().sort(), hookNames.slice().sort());
    assert.deepEqual(claude.unwired.slice().sort(), hookNames.slice().sort());
    assert.match(result.message, /forge-hooks\.snippet\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: surfaces in the returned report never carry the internal `hint` field', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-model-hook.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    writeJsonFile(cwd, ['.claude', 'settings.json'], { hooks: {} });

    const result = checkHookWiring({ cwd });

    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.ok(claude);
    // `hint` is used internally to build `message` (asserted below) but must
    // be stripped from the returned surface objects — it is not part of the
    // report's public shape.
    assert.equal('hint' in claude, false);
    // Prove `hint` was actually consumed, not just absent by coincidence.
    assert.match(result.message, /merge \.claude\/forge-hooks\.snippet\.json into \.claude\/settings\.json/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: partial wiring reports exactly the unreferenced subset', () => {
  const cwd = makeTempProject();
  try {
    const wiredName = 'forge-model-hook.mjs';
    const unwiredNames = [
      'forge-session-start.mjs',
      'forge-pre-commit.mjs',
      'forge-post-tool.mjs',
    ];
    writeHookFiles(cwd, ['.claude', 'hooks'], [wiredName, ...unwiredNames]);
    writeJsonFile(cwd, ['.claude', 'settings.json'], {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${wiredName}"`,
              },
            ],
          },
        ],
      },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, false);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired.slice().sort(), unwiredNames.slice().sort());
    assert.equal(claude.unwired.includes(wiredName), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: wiring via settings.local.json alone passes', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-model-hook.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    const localPath = writeJsonFile(cwd, ['.claude', 'settings.local.json'], {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${hookNames[0]}"`,
              },
            ],
          },
        ],
      },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, true);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired, []);
    assert.deepEqual(claude.wiringPaths, [localPath]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: malformed settings.json with hooks on disk fails and reports the parse problem', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-model-hook.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ this is not valid json');

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, false);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired, hookNames);
    assert.ok(claude.wiringError);
    assert.ok(
      result.message.includes(claude.wiringError),
      `expected message to include parse problem, got: ${result.message}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: cursor surface wired via hooks.json passes', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-session-start.mjs'];
    writeHookFiles(cwd, ['.cursor', 'hooks'], hookNames);
    writeJsonFile(cwd, ['.cursor', 'hooks.json'], {
      version: 1,
      hooks: {
        afterFileEdit: [
          { command: `node "$CURSOR_PROJECT_DIR/.cursor/hooks/${hookNames[0]}"` },
        ],
      },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, true);
    const cursor = result.surfaces.find((s) => s.surface === 'cursor');
    assert.ok(cursor);
    assert.deepEqual(cursor.unwired, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: cursor surface unwired fails', () => {
  const cwd = makeTempProject();
  try {
    const hookNames = ['forge-session-start.mjs'];
    writeHookFiles(cwd, ['.cursor', 'hooks'], hookNames);
    writeJsonFile(cwd, ['.cursor', 'hooks.json'], {
      version: 1,
      hooks: { afterFileEdit: [] },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, false);
    const cursor = result.surfaces.find((s) => s.surface === 'cursor');
    assert.deepEqual(cursor.unwired, hookNames);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: a wrapper script name does not mask the real hook (path-boundary match, not bare substring)', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    writeHookFiles(cwd, ['.claude', 'hooks'], [hookName]);
    // Only a wrapper script is referenced — the real hook is not.
    writeJsonFile(cwd, ['.claude', 'settings.json'], {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/my-${hookName}"`,
              },
            ],
          },
        ],
      },
    });

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, false, 'the wrapper must not count as wiring the real hook');
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired, [hookName]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: non-forge files in the hooks dir are ignored', () => {
  const cwd = makeTempProject();
  try {
    writeHookFiles(cwd, ['.claude', 'hooks'], ['eslint-changed.mjs']);

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.surfaces, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: leftover retired forge-triage-hook.mjs does not fail as unwired', () => {
  const cwd = makeTempProject();
  try {
    writeHookFiles(cwd, ['.claude', 'hooks'], ['forge-triage-hook.mjs']);

    const result = checkHookWiring({ cwd });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.surfaces, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Task 2.1: checkHookWiring wired into runDoctorChecks / runDoctor / warnIfDoctorFails ---

function okRunCommand() {
  return { status: 0, stdout: '1.0.0', stderr: '' };
}

test('runDoctorChecks: checks.hooks present (id hook-wiring, skipped) for openspec engine', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.equal(report.engine, 'openspec');
    assert.equal(report.checks.project.ok, true);
    assert.equal(report.checks.cli.ok, true);
    assert.ok(report.checks.hooks, 'expected checks.hooks to be present');
    assert.equal(report.checks.hooks.id, 'hook-wiring');
    assert.equal(report.checks.hooks.skipped, true);
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: checks.hooks present (id hook-wiring, skipped) for specs engine', () => {
  const cwd = makeTempProject();
  try {
    writeJsonFile(cwd, ['.forge', 'config.json'], { plan: { engine: 'specs', dir: 'specs' } });
    fs.mkdirSync(path.join(cwd, 'specs', 'changes'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'specs', 'specs'), { recursive: true });

    const report = runDoctorChecks({ cwd });

    assert.equal(report.engine, 'specs');
    assert.equal(report.checks.project.ok, true);
    assert.ok(report.checks.hooks, 'expected checks.hooks to be present');
    assert.equal(report.checks.hooks.id, 'hook-wiring');
    assert.equal(report.checks.hooks.skipped, true);
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: unwired hooks fail overall ok even when project+cli pass', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
    const hookNames = ['forge-session-start.mjs', 'forge-model-hook.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    // no settings.json at all -> nothing wired

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.equal(report.checks.project.ok, true);
    assert.equal(report.checks.cli.ok, true);
    assert.equal(report.checks.hooks.ok, false);
    assert.deepEqual(
      report.checks.hooks.surfaces.find((s) => s.surface === 'claude').unwired.slice().sort(),
      hookNames.slice().sort(),
    );
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: unwired hooks fail overall ok on the specs-engine branch too', () => {
  const cwd = makeTempProject();
  try {
    writeJsonFile(cwd, ['.forge', 'config.json'], { plan: { engine: 'specs', dir: 'specs' } });
    fs.mkdirSync(path.join(cwd, 'specs', 'changes'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'specs', 'specs'), { recursive: true });
    const hookNames = ['forge-session-start.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
    // no settings.json -> nothing wired

    const report = runDoctorChecks({ cwd });

    assert.equal(report.engine, 'specs');
    assert.equal(report.checks.project.ok, true);
    assert.equal(report.checks.cli.ok, true);
    assert.equal(report.checks.hooks.ok, false);
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function makeUnwiredFixture() {
  const cwd = makeTempProject();
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
  const hookNames = ['forge-session-start.mjs'];
  writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
  return { cwd, hookNames };
}

function makeWiredFixture() {
  const cwd = makeTempProject();
  fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
  const hookNames = ['forge-session-start.mjs'];
  writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);
  writeJsonFile(cwd, ['.claude', 'settings.json'], {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookNames[0]}"`,
            },
          ],
        },
      ],
    },
  });
  return { cwd, hookNames };
}

test('runDoctor(["--json"]) exits 1 for a fully-unwired project (project+cli otherwise pass)', () => {
  const { cwd } = makeUnwiredFixture();
  try {
    const out = capture();
    const err = capture();
    const code = runDoctor(['--json'], {
      cwd,
      stdout: out.stream,
      stderr: err.stream,
      runCommand: okRunCommand,
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.checks.hooks.ok, false);
    assert.equal(parsed.checks.project.ok, true);
    assert.equal(parsed.checks.cli.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctor(["--warn-only"]) still exits 0 for a fully-unwired project', () => {
  const { cwd } = makeUnwiredFixture();
  try {
    const out = capture();
    const err = capture();
    const code = runDoctor(['--warn-only'], {
      cwd,
      stdout: out.stream,
      stderr: err.stream,
      runCommand: okRunCommand,
    });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctor human output prints a third [FAIL] line naming the unwired basenames', () => {
  const { cwd, hookNames } = makeUnwiredFixture();
  try {
    const out = capture();
    const err = capture();
    runDoctor([], { cwd, stdout: out.stream, stderr: err.stream, runCommand: okRunCommand });
    const text = out.text();
    assert.match(text, /\[FAIL\]/);
    for (const name of hookNames) {
      assert.ok(text.includes(name), `expected human output to include ${name}, got: ${text}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctor human output prints an [ok] hooks line when the check is skipped', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
    const out = capture();
    const err = capture();
    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });
    runDoctor([], { cwd, stdout: out.stream, stderr: err.stream, runCommand: okRunCommand });
    const text = out.text();
    assert.ok(
      text.includes(`[ok] ${report.checks.hooks.message}`),
      `expected human output to include the skipped hooks line, got: ${text}`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('warnIfDoctorFails writes the hooks message to stderr for an unwired fixture', () => {
  const { cwd, hookNames } = makeUnwiredFixture();
  try {
    const err = capture();
    const report = warnIfDoctorFails({ cwd, stderr: err.stream, runCommand: okRunCommand });
    assert.equal(report.checks.hooks.ok, false);
    const text = err.text();
    for (const name of hookNames) {
      assert.ok(text.includes(name), `expected stderr to include ${name}, got: ${text}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('warnIfDoctorFails writes nothing hook-related for a wired fixture', () => {
  const { cwd, hookNames } = makeWiredFixture();
  try {
    const err = capture();
    const report = warnIfDoctorFails({ cwd, stderr: err.stream, runCommand: okRunCommand });
    assert.equal(report.checks.hooks.ok, true);
    assert.equal(report.ok, true);
    assert.equal(err.text(), '');
    assert.ok(!err.text().includes(hookNames[0]));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks threads injected readFileSync/readdirSync into the hook-wiring check (no real disk involved)', () => {
  const cwd = '/proj-injected-fs-test';
  const hooksDir = path.join(cwd, '.claude', 'hooks');
  const openspecConfig = path.join(cwd, 'openspec', 'config.yaml');
  const hookName = 'forge-session-start.mjs';

  const existsSync = (p) => p === openspecConfig || p === hooksDir;
  const readdirSync = (p) => {
    if (p === hooksDir) return [hookName, 'eslint-changed.mjs'];
    throw new Error(`unexpected readdirSync(${p})`);
  };
  const readFileSync = () => {
    throw new Error('readFileSync should not be called: no wiring files exist');
  };

  const report = runDoctorChecks({
    cwd,
    existsSync,
    readdirSync,
    readFileSync,
    runCommand: okRunCommand,
  });

  assert.equal(report.checks.project.ok, true);
  assert.equal(report.checks.cli.ok, true);
  assert.equal(report.checks.hooks.ok, false);
  assert.equal(report.checks.hooks.skipped, false);
  assert.deepEqual(
    report.checks.hooks.surfaces.find((s) => s.surface === 'claude').unwired,
    [hookName],
  );
  assert.equal(report.ok, false);
});

// --- Task 6.1 / F74: `forge doctor --install` merges the hooks snippet too ---

test('runDoctorChecks: --install repairs an unwired claude surface (openspec engine)', () => {
  const { cwd, hookNames } = makeUnwiredFixture();
  try {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    assert.equal(fs.existsSync(settingsPath), false, 'fixture sanity: no settings.json yet');

    const report = runDoctorChecks({ cwd, install: true, runCommand: okRunCommand });

    assert.equal(report.checks.hooks.ok, true, 'install repaired the hook-wiring check');
    // Re-derive independently from real disk, not just the trusted report.
    const recheck = checkHookWiring({ cwd });
    assert.equal(recheck.ok, true);
    const claude = recheck.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired, []);
    assert.ok(fs.existsSync(settingsPath), 'settings.json created by --install');
    assert.ok(hookNames.length > 0, 'fixture sanity: at least one hook file present');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: without --install, an unwired claude surface is left alone', () => {
  const { cwd } = makeUnwiredFixture();
  try {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');

    const report = runDoctorChecks({ cwd, install: false, runCommand: okRunCommand });

    assert.equal(report.checks.hooks.ok, false, 'not repaired without --install');
    assert.equal(fs.existsSync(settingsPath), false, 'settings.json not created without --install');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: --install repairs an unwired claude surface (specs engine)', () => {
  const cwd = makeTempProject();
  try {
    writeJsonFile(cwd, ['.forge', 'config.json'], { plan: { engine: 'specs', dir: 'specs' } });
    fs.mkdirSync(path.join(cwd, 'specs', 'changes'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'specs', 'specs'), { recursive: true });
    const hookNames = ['forge-session-start.mjs'];
    writeHookFiles(cwd, ['.claude', 'hooks'], hookNames);

    const report = runDoctorChecks({ cwd, install: true });

    assert.equal(report.engine, 'specs');
    assert.equal(report.checks.hooks.ok, true, 'install repaired the hook-wiring check');
    const recheck = checkHookWiring({ cwd });
    assert.equal(recheck.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: --install merge preserves an existing unrelated hook in settings.json', () => {
  const { cwd } = makeUnwiredFixture();
  try {
    const userGroup = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node scripts/user-lint.mjs' }],
    };
    writeJsonFile(cwd, ['.claude', 'settings.json'], { hooks: { PreToolUse: [userGroup] } });

    runDoctorChecks({ cwd, install: true, runCommand: okRunCommand });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse[0], userGroup, 'user group preserved verbatim');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: --install repairs an unwired cursor surface too (F84)', () => {
  const cwd = makeTempProject();
  try {
    writeJsonFile(cwd, ['.forge', 'config.json'], { plan: { engine: 'specs', dir: 'specs' } });
    fs.mkdirSync(path.join(cwd, 'specs', 'changes'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'specs', 'specs'), { recursive: true });
    writeHookFiles(cwd, ['.cursor', 'hooks'], ['forge-session-start.mjs']);
    const hooksJsonPath = path.join(cwd, '.cursor', 'hooks.json');
    assert.equal(fs.existsSync(hooksJsonPath), false, 'fixture sanity: no hooks.json yet');

    const report = runDoctorChecks({ cwd, install: true });

    assert.equal(report.checks.hooks.ok, true, 'install repaired the cursor surface');
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json created by --install');
    const hooksDoc = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.match(
      JSON.stringify(hooksDoc.hooks),
      /forge-session-start\.mjs/,
      'the merge references the on-disk hook',
    );
    const recheck = checkHookWiring({ cwd });
    assert.equal(recheck.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkHookWiring: an unreadable hooks dir is a failure, not a clean skip (F76)', () => {
  const cwd = makeTempProject();
  try {
    writeHookFiles(cwd, ['.claude', 'hooks'], ['forge-session-start.mjs']);
    const result = checkHookWiring({
      cwd,
      readdirSync: () => {
        throw new Error('EACCES: permission denied, scandir');
      },
    });
    assert.equal(result.ok, false, 'a read error must fail the check');
    assert.equal(result.skipped, false, 'and must not be laundered into "no hooks found"');
    assert.match(result.message, /unreadable/);
    assert.match(result.message, /EACCES/);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.ok(claude);
    assert.equal(claude.ok, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- agents-install-target: project .agents/skills/forge copy ---

test('runDoctorChecks: absent .agents/skills/forge means no agents-skill check at all', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.equal(report.checks.agentsSkill, undefined, 'check skipped entirely when absent');
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: an unversioned .agents/skills/forge copy warns without flipping the exit code', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
    fs.mkdirSync(path.join(cwd, '.agents', 'skills', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agents', 'skills', 'forge', 'SKILL.md'), '# stale copy\n');

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.ok(report.checks.agentsSkill, 'check present when the dir exists');
    assert.equal(report.checks.agentsSkill.warning, true);
    assert.match(report.checks.agentsSkill.message, /\.agents[/\\]skills[/\\]forge/);
    assert.match(report.checks.agentsSkill.message, /stale/);
    assert.match(report.checks.agentsSkill.message, /forge init --agents/);
    assert.equal(report.ok, true, 'a stale project copy is a warning, not a failure');

    const out = capture();
    const err = capture();
    const code = runDoctor([], {
      cwd,
      stdout: out.stream,
      stderr: err.stream,
      runCommand: okRunCommand,
    });
    assert.equal(code, 0, 'exit code unaffected by the stale-copy warning');
    assert.match(out.text(), /forge init --agents/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: a current .agents/skills/forge copy is present with no warning', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
    // home: cwd puts the managed dir at <cwd>/.agents/skills/forge — the
    // exact tree `forge init --agents` writes, stamp and all.
    installSkillsToAgents(['forge'], ['agents'], { home: cwd });

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.ok(report.checks.agentsSkill, 'check present when the dir exists');
    assert.equal(report.checks.agentsSkill.warning, false);
    assert.equal(report.checks.agentsSkill.status, 'present');
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('runDoctorChecks: a valid stamp with a wrong contentHash warns as outdated, exit unaffected', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'openspec', 'config.yaml'), 'x: 1\n');
    installSkillsToAgents(['forge'], ['agents'], { home: cwd });
    const stampPath = path.join(cwd, '.agents', 'skills', 'forge', FORGEKIT_STAMP);
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    stamp.contentHash = 'deadbeef';
    fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

    const report = runDoctorChecks({ cwd, runCommand: okRunCommand });

    assert.equal(report.checks.agentsSkill.status, 'outdated');
    assert.equal(report.checks.agentsSkill.warning, true);
    assert.match(report.checks.agentsSkill.message, /forge init --agents/);
    assert.equal(report.ok, true, 'an outdated copy is a warning, not a failure');

    const out = capture();
    const err = capture();
    const code = runDoctor([], {
      cwd,
      stdout: out.stream,
      stderr: err.stream,
      runCommand: okRunCommand,
    });
    assert.equal(code, 0, 'exit code unaffected by the outdated-copy warning');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const FORGE_BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));
function runForge(args, cwd) {
  return spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8' });
}

test('end-to-end: `forge doctor --install` reaches the same wired state `forge doctor` then reports green', () => {
  const cwd = makeTempProject();
  try {
    fs.mkdirSync(path.join(cwd, 'specs', 'changes'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'specs', 'specs'), { recursive: true });
    writeJsonFile(cwd, ['.forge', 'config.json'], { plan: { engine: 'specs', dir: 'specs' } });
    writeHookFiles(cwd, ['.claude', 'hooks'], ['forge-session-start.mjs']);

    const before = runForge(['doctor'], cwd);
    assert.equal(before.status, 1, `expected unwired project to fail first: ${before.stdout}`);

    const install = runForge(['doctor', '--install'], cwd);
    assert.equal(install.status, 0, `forge doctor --install failed: ${install.stdout}\n${install.stderr}`);

    const after = runForge(['doctor'], cwd);
    assert.equal(after.status, 0, `forge doctor still failing after --install: ${after.stdout}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('path join uses openspec/config.yaml', () => {
  const result = checkOpenSpecProject({
    cwd: path.join('S:', 'Projects', 'janus'),
    existsSync: (p) => p.endsWith(path.join('openspec', 'config.yaml')),
  });
  assert.equal(result.ok, true);
});
