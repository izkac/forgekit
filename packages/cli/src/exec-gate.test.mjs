import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_EXEC_ENV,
  CALLER_EXEC_SPAWN,
  callerExecDeniedMessage,
  envAllowsCallerExec,
  formatCallerArgv,
  prefsAllowCallerExec,
  promptCallerExecConfirm,
  resolveCallerExecGate,
} from './exec-gate.mjs';
import { writeLocalPreferences } from './preferences.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const TDD_RUN = path.join(SRC, 'tdd-run.mjs');
const EVIDENCE = path.join(SRC, 'record-evidence.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeProject() {
  const root = tmp('exec-gate-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'fixture', phase: 'implement' })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  return { root, sessionDir };
}

test('envAllowsCallerExec: only 1/true/yes/on, case-insensitive', () => {
  assert.equal(envAllowsCallerExec({}), false);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: '' }), false);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: '0' }), false);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: 'false' }), false);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: '1' }), true);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: 'TRUE' }), true);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: 'yes' }), true);
  assert.equal(envAllowsCallerExec({ [ALLOW_EXEC_ENV]: 'on' }), true);
});

test('prefsAllowCallerExec: only the explicit true flag', () => {
  assert.equal(prefsAllowCallerExec(null), false);
  assert.equal(prefsAllowCallerExec({}), false);
  assert.equal(prefsAllowCallerExec({ exec: { allowCallerCommands: false } }), false);
  assert.equal(prefsAllowCallerExec({ exec: { allowCallerCommands: true } }), true);
});

test('resolveCallerExecGate: blocked by default (no env, no pref, confirm false)', () => {
  const dir = tmp('exec-gate-deny-');
  const gate = resolveCallerExecGate({
    command: 'forge tdd run',
    cmdArgv: ['true'],
    cwd: dir,
    env: {},
    confirm: false,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.source, null);
  assert.match(gate.message, /FORGEKIT_ALLOW_EXEC/);
  assert.match(gate.message, /exec\.allowCallerCommands/);
  assert.match(gate.message, /shell: false/);
});

test('resolveCallerExecGate: allowed when FORGEKIT_ALLOW_EXEC=1', () => {
  const gate = resolveCallerExecGate({
    command: 'forge tdd run',
    cmdArgv: ['true'],
    env: { [ALLOW_EXEC_ENV]: '1' },
    confirm: false,
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.source, 'env');
});

test('resolveCallerExecGate: allowed when exec.allowCallerCommands is set', () => {
  const forgeDir = tmp('exec-gate-pref-');
  writeLocalPreferences({ forgeDir, patch: { exec: { allowCallerCommands: true } } });
  const gate = resolveCallerExecGate({
    command: 'forge evidence',
    cmdArgv: ['true'],
    forgeDir,
    env: {},
    confirm: false,
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.source, 'pref');
});

test('resolveCallerExecGate: allowed when confirm returns true', () => {
  const gate = resolveCallerExecGate({
    command: 'forge tdd run',
    cmdArgv: ['rm', '-rf', '/'],
    env: {},
    confirm: () => true,
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.source, 'confirm');
});

test('promptCallerExecConfirm: non-TTY refuses without reading', () => {
  const stdin = { isTTY: false, fd: 0 };
  const stderr = { isTTY: true, write() {} };
  assert.equal(promptCallerExecConfirm(['true'], { stdin, stderr, readLine: () => 'y' }), false);
});

test('promptCallerExecConfirm: TTY y/yes opts in; anything else refuses', () => {
  const stdin = { isTTY: true, fd: 0 };
  const stderr = { isTTY: true, written: '', write(chunk) { this.written += chunk; return true; } };
  assert.equal(promptCallerExecConfirm(['node', '-e', '0'], { stdin, stderr, readLine: () => 'y' }), true);
  assert.match(stderr.written, /shell: false/);
  assert.equal(promptCallerExecConfirm(['true'], { stdin, stderr, readLine: () => 'yes' }), true);
  assert.equal(promptCallerExecConfirm(['true'], { stdin, stderr, readLine: () => 'n' }), false);
  assert.equal(promptCallerExecConfirm(['true'], { stdin, stderr, readLine: () => '' }), false);
});

test('CALLER_EXEC_SPAWN is shell:false — the argv contract both exec sites share', () => {
  assert.deepEqual(CALLER_EXEC_SPAWN, { shell: false });
  const tdd = fs.readFileSync(path.join(SRC, 'tdd-run.mjs'), 'utf8');
  const evidence = fs.readFileSync(path.join(SRC, 'record-evidence.mjs'), 'utf8');
  assert.match(tdd, /spawn\(cmd, cmdArgs, \{ cwd: REPO_ROOT, stdio: 'inherit', \.\.\.CALLER_EXEC_SPAWN \}\)/);
  assert.match(evidence, /\.\.\.CALLER_EXEC_SPAWN/);
  assert.doesNotMatch(tdd, /spawn\([^)]*shell:\s*true/);
  assert.doesNotMatch(evidence, /spawnSync\([^)]*shell:\s*true/);
});

test('formatCallerArgv quotes tokens that need it', () => {
  assert.equal(formatCallerArgv(['node', '-e', 'process.exit(0)']), 'node -e process.exit(0)');
  assert.equal(formatCallerArgv(['echo', 'hello world']), 'echo "hello world"');
});

test('forge tdd run: blocked by default — child argv is not spawned', () => {
  const { root, sessionDir } = makeProject();
  const marker = path.join(root, 'ran.txt');
  const env = { ...process.env };
  delete env[ALLOW_EXEC_ENV];
  const r = spawnSync(
    process.execPath,
    [TDD_RUN, 'run', '--task', '01-x', '--expect', 'pass', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    { cwd: root, encoding: 'utf8', env },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FORGEKIT_ALLOW_EXEC|opt-in/i);
  assert.equal(fs.existsSync(marker), false, 'the child must not have run');
  assert.equal(fs.existsSync(path.join(sessionDir, 'tasks', '01-x', 'tdd-runs.jsonl')), false);
});

test('forge tdd run: allowed when FORGEKIT_ALLOW_EXEC=1, still shell:false', () => {
  const { root, sessionDir } = makeProject();
  const r = spawnSync(
    process.execPath,
    [TDD_RUN, 'run', '--task', '01-x', '--expect', 'pass', '--', process.execPath, '-e', 'process.exit(0)'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, [ALLOW_EXEC_ENV]: '1' } },
  );
  assert.equal(r.status, 0, r.stderr);
  const stamps = fs
    .readFileSync(path.join(sessionDir, 'tasks', '01-x', 'tdd-runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(stamps[0].ok, true);
  assert.equal(stamps[0].cmd, process.execPath);
  assert.deepEqual(stamps[0].args, ['-e', 'process.exit(0)']);
});

test('forge evidence executed mode: blocked by default, allowed when opted in', () => {
  const { root } = makeProject();
  const envOff = { ...process.env };
  delete envOff[ALLOW_EXEC_ENV];
  const blocked = spawnSync(
    process.execPath,
    [EVIDENCE, '--task', '01-x', '--', process.execPath, '-e', "console.log('hi')"],
    { cwd: root, encoding: 'utf8', env: envOff },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /FORGEKIT_ALLOW_EXEC|opt-in/i);
  assert.equal(
    fs.existsSync(path.join(root, '.forge', 'sessions', 's1', 'tasks', '01-x', 'test-evidence.md')),
    false,
  );

  const allowed = spawnSync(
    process.execPath,
    [EVIDENCE, '--task', '01-x', '--', process.execPath, '-e', "console.log('hi')"],
    { cwd: root, encoding: 'utf8', env: { ...process.env, [ALLOW_EXEC_ENV]: '1' } },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(
    fs.readFileSync(path.join(root, '.forge', 'sessions', 's1', 'tasks', '01-x', 'test-evidence.md'), 'utf8'),
    /Exit code:\*\* 0/,
  );
});

test('callerExecDeniedMessage names both opt-in paths', () => {
  const text = callerExecDeniedMessage('forge tdd run');
  assert.match(text, /FORGEKIT_ALLOW_EXEC=1/);
  assert.match(text, /exec\.allowCallerCommands=true/);
  assert.match(text, /TTY/);
});
