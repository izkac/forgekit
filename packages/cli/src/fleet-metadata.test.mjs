import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectEngine, entryFile, listFleet, registerSession, syncProjectSessions } from './lib/fleet.mjs';
import { saveSession } from './lib.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CURSOR_TRACE_ID', 'CURSOR_AGENT',
  'CURSOR_CONVERSATION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  'DSH_SHELL', 'DSH_SESSION_ID', 'OPENCODE', 'OPENCODE_TERMINAL',
];

function envFor(patch = {}) {
  const env = { ...process.env };
  for (const key of ENGINE_VARS) delete env[key];
  return { ...env, ...patch };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, 'registry');
  const before = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = registry;
  t.after(() => {
    if (before === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = before;
  });
  return { root, registry };
}

function worktreeFixture(t) {
  const f = fixture(t);
  const project = path.join(f.root, 'Projects with spaces', 'Volo');
  const worktree = path.join(f.root, 't3-9fc2be3a');
  fs.mkdirSync(project, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-q', '--allow-empty', '-m', 'base');
  git('worktree', 'add', '-q', '-b', 't3/fixture', worktree);
  fs.mkdirSync(path.join(worktree, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.forge', 'config.json'), JSON.stringify({ plan: { engine: 'specs' } }));
  fs.mkdirSync(path.join(worktree, 'specs', 'changes'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'specs', 'specs'), { recursive: true });
  return { ...f, project, worktree };
}

function writeSession(project, engine) {
  const session = {
    id: 's1', slug: 'savable-system-views', phase: 'implement',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(engine ? { engine } : {}),
  };
  const dir = path.join(project, '.forge', 'sessions', session.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session));
  return session;
}

test('detectEngine identifies the engine inside T3 rather than the T3 shell', () => {
  assert.equal(detectEngine({ CODEX_THREAD_ID: 'codex-thread', T3CODE_CLI_PATH: '/t3' }), 'codex');
  assert.equal(detectEngine({ CODEX_SESSION_ID: 'codex-session' }), 'codex');
  assert.equal(detectEngine({ CLAUDE_CODE_SESSION_ID: 'claude-session', T3CODE_CLI_PATH: '/t3' }), 'claude');
  assert.equal(detectEngine({ CURSOR_CONVERSATION_ID: 'cursor-session' }), 'cursor');
  assert.equal(detectEngine({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectEngine({ CURSOR_AGENT: '1' }), 'cursor');
  assert.equal(detectEngine({ T3CODE_CLI_PATH: '/t3', CLAUDE_AGENT_SDK_VERSION: '1', CODEX_HOME: '/codex' }), null);
  assert.equal(detectEngine({ CODEX_THREAD_ID: '   ' }), null);
});

test('detectEngine recognizes DeepSeek Harness and OpenCode runtime markers', () => {
  assert.equal(detectEngine({ DSH_SHELL: '1', DSH_SESSION_ID: 'dsh-session' }), 'deepseek');
  assert.equal(detectEngine({ DSH_SHELL: '1' }), 'deepseek');
  assert.equal(detectEngine({ DSH_SESSION_ID: 'dsh-session' }), 'deepseek');
  assert.equal(detectEngine({ OPENCODE: '1', OPENCODE_PID: '123' }), 'opencode');
  assert.equal(detectEngine({ OPENCODE_TERMINAL: '1' }), 'opencode');
  assert.equal(detectEngine({ DSH_HOME: '/dsh', DEEPSEEK_API_KEY: 'fixture', OPENCODE_CONFIG: '/config' }), null);
  assert.equal(detectEngine({ DSH_SHELL: '0', DSH_SESSION_ID: ' ', OPENCODE: '0', OPENCODE_TERMINAL: '0' }), null);
  assert.equal(detectEngine({ OPENCODE: '/usr/bin/opencode' }), null);
});

test('linked worktree registration uses the repository name and keeps its own session path', (t) => {
  const { project, worktree } = worktreeFixture(t);
  registerSession(worktree, writeSession(worktree));
  registerSession(project, writeSession(project));
  const entries = listFleet();
  assert.equal(entries.length, 2, 'worktrees remain separate fleet entries');
  assert.ok(entries.every((e) => e.projectName === 'Volo'));
  assert.ok(entries.some((e) => e.project === worktree));
  assert.ok(entries.some((e) => e.project === project));
});

test('worktree names resolve through relative Git pointers too', (t) => {
  const { project, worktree } = worktreeFixture(t);
  const gitDir = path.join(project, '.git', 'worktrees', path.basename(worktree));
  // Git marks this file hidden on Windows; replace it rather than opening it
  // with Node's truncate flag, which Windows rejects for hidden files.
  fs.rmSync(path.join(worktree, '.git'));
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, gitDir)}\n`);
  registerSession(worktree, writeSession(worktree));
  assert.equal(listFleet()[0].projectName, 'Volo');
});

test('ordinary projects and submodule-style Git pointers retain their directory names', (t) => {
  const { root } = fixture(t);
  for (const [name, pointer] of [
    ['plain', null], ['broken', 'not a git pointer'],
    ['submodule', 'gitdir: ../parent/.git/modules/submodule\n'],
  ]) {
    const project = path.join(root, name);
    const session = writeSession(project);
    if (pointer) fs.writeFileSync(path.join(project, '.git'), pointer);
    registerSession(project, session);
    assert.equal(JSON.parse(fs.readFileSync(entryFile(project, 's1'), 'utf8')).projectName, name);
  }
});

test('fleet list repairs an already-registered T3 worktree name without borrowing the viewer engine', (t) => {
  const { worktree } = worktreeFixture(t);
  registerSession(worktree, writeSession(worktree));
  const file = entryFile(worktree, 's1');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.projectName = path.basename(worktree);
  old.engine = null;
  fs.writeFileSync(file, JSON.stringify(old));
  const [entry] = listFleet();
  assert.equal(entry.projectName, 'Volo');
  assert.equal(entry.engine, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projectName, 'Volo');
});

for (const [engineName, markers] of [
  ['codex', { CODEX_THREAD_ID: 'codex-fixture' }],
  ['deepseek', { DSH_SHELL: '1', DSH_SESSION_ID: 'dsh-fixture' }],
  ['opencode', { OPENCODE: '1', OPENCODE_PID: '123' }],
  ['opencode', { OPENCODE_TERMINAL: '1' }],
]) test(`forge new in a T3 worktree persists ${engineName} (${Object.keys(markers)[0]}) for later shell sync and listing`, (t) => {
  const { worktree, registry } = worktreeFixture(t);
  const out = execFileSync(process.execPath, [path.join(SRC, 'new-session.mjs'), 't3-fixture'], {
    cwd: worktree,
    env: envFor({ ...markers, FORGEKIT_FLEET_DIR: registry }),
    encoding: 'utf8',
  });
  const { sessionId } = JSON.parse(out);
  const session = JSON.parse(fs.readFileSync(path.join(worktree, '.forge', 'sessions', sessionId, 'session.json'), 'utf8'));
  assert.equal(session.engine, engineName);
  for (const engine of [undefined, { CLAUDECODE: '1' }]) {
    execFileSync(process.execPath, [path.join(SRC, 'fleet.mjs'), 'sync'], {
      cwd: worktree, env: envFor({ ...engine, FORGEKIT_FLEET_DIR: registry }),
    });
    const entries = JSON.parse(execFileSync(process.execPath, [path.join(SRC, 'fleet.mjs'), 'list', '--json'], {
      env: envFor({ CLAUDECODE: '1', FORGEKIT_FLEET_DIR: registry }), encoding: 'utf8',
    }));
    assert.equal(entries[0].projectName, 'Volo');
    assert.equal(entries[0].engine, engineName);
  }
  const table = execFileSync(process.execPath, [path.join(SRC, 'fleet.mjs'), 'list'], {
    env: envFor({ FORGEKIT_FLEET_DIR: registry }), encoding: 'utf8',
  });
  assert.match(table, new RegExp(`^Volo\\s+t3-fixture\\s+${engineName}\\s`, 'm'));
});

test('saving a resumed session records its current engine and a later plain shell preserves it', (t) => {
  const { root } = fixture(t);
  const project = path.join(root, 'Volo');
  const session = writeSession(project, 'claude');
  const dir = path.join(project, '.forge', 'sessions', session.id);
  const original = Object.fromEntries(ENGINE_VARS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENGINE_VARS) delete process.env[key];
    process.env.CODEX_THREAD_ID = 'resumed-in-codex';
    saveSession(dir, session);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).engine, 'codex');
    delete process.env.CODEX_THREAD_ID;
    saveSession(dir, session);
    assert.equal(listFleet()[0].engine, 'codex');
    process.env.CLAUDE_CODE_SESSION_ID = 'resumed-in-claude';
    saveSession(dir, session);
    assert.equal(listFleet()[0].engine, 'claude');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('fleet sync keeps a stored session engine and leaves an unknown engine unknown', (t) => {
  const { root } = fixture(t);
  for (const engine of ['claude', null]) {
    const project = path.join(root, engine ?? 'unknown');
    writeSession(project, engine);
    syncProjectSessions(project);
    const entry = JSON.parse(fs.readFileSync(entryFile(project, 's1'), 'utf8'));
    assert.equal(entry.engine, engine);
  }
});
