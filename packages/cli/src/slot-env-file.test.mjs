import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatSlotEnv, renderSlotEnv, writeSlotEnvFile } from './lib/slots.mjs';

const BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

function forge(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
}

function writeConfig(dir, config) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), JSON.stringify(config), 'utf8');
}

/** A repo with one commit and `count` linked worktrees (creation order = slot order). */
function makeRepo(count = 1) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-slotenv-')));
  made.push(base);
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 'slots@example.test']);
  git(main, ['config', 'user.name', 'slots']);
  git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const worktrees = [];
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(base, `w${i + 1}`);
    git(main, ['worktree', 'add', '-q', '-b', `branch-${i + 1}`, dir]);
    worktrees.push(dir);
  }
  return { main, worktrees };
}

const TEMPLATES = { PORT: '{3000+slot}', DATABASE_URL: 'postgres://localhost/app_{slot}' };

/** The exact file content the writer should produce for `templates` at `slot`. */
function expectedFile(templates, slot) {
  return `# written by forge — slot ${slot}; do not edit\n${formatSlotEnv(renderSlotEnv(templates, slot).vars, 'dotenv')}`;
}

const envFile = (dir) => path.join(dir, '.forge', 'slot.env');
const PAST = new Date('2020-01-01T00:00:00Z');

test('forge slot writes .forge/slot.env in dotenv syntax with the header comment', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  const res = forge(dir, ['slot']);
  assert.equal(res.status, 0, res.stderr);
  const slot = Number(res.stdout);
  assert.ok(slot >= 1);
  assert.equal(fs.readFileSync(envFile(dir), 'utf8'), expectedFile(TEMPLATES, slot));
  assert.equal(fs.readFileSync(envFile(dir), 'utf8').split('\n')[0], `# written by forge — slot ${slot}; do not edit`);
});

test('forge slot env writes the file too, with the same content', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  const res = forge(dir, ['slot', 'env']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(envFile(dir), 'utf8'), expectedFile(TEMPLATES, 1));
});

test('an unchanged file is not rewritten: its mtime survives a second run', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  assert.equal(forge(dir, ['slot']).status, 0);
  fs.utimesSync(envFile(dir), PAST, PAST);
  const before = fs.statSync(envFile(dir)).mtimeMs;
  assert.equal(before, PAST.getTime());
  const again = forge(dir, ['slot']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.statSync(envFile(dir)).mtimeMs, before, 'the second run rewrote an identical file');
});

test('changing the config rewrites the file', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  assert.equal(forge(dir, ['slot']).status, 0);
  fs.utimesSync(envFile(dir), PAST, PAST);
  const changed = { ...TEMPLATES, PORT: '{4000+slot}' };
  writeConfig(dir, { slots: { env: changed } });
  assert.equal(forge(dir, ['slot']).status, 0);
  assert.equal(fs.readFileSync(envFile(dir), 'utf8'), expectedFile(changed, 1));
  assert.notEqual(fs.statSync(envFile(dir)).mtimeMs, PAST.getTime(), 'a changed file must be written');
});

test('without slots.env no command creates the file', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { git: { checkpoint: 'off' } });
  assert.equal(forge(dir, ['slot']).status, 0);
  assert.equal(forge(dir, ['slot', 'env']).status, 0);
  const created = forge(dir, ['new', 'demo']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(forge(dir, ['reminder', '--format', 'claude-session-start']).status, 0);
  assert.equal(fs.existsSync(envFile(dir)), false, '.forge/slot.env must not exist when slots.env is not configured');
});

test('forge new writes the file when slots.env is configured', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  assert.equal(fs.existsSync(envFile(dir)), false);
  const res = forge(dir, ['new', 'demo']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(envFile(dir), 'utf8'), expectedFile(TEMPLATES, 1));
});

test('forge reminder writes the file at session start (claude-session-start and cursor), not on a per-prompt call', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  const created = forge(dir, ['new', 'demo']);
  assert.equal(created.status, 0, created.stderr);
  fs.rmSync(envFile(dir));

  for (const args of [
    ['reminder', '--format', 'plain'],
    ['reminder', '--format', 'plain', '--prompt', 'do the thing'],
  ]) {
    const res = forge(dir, args);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(envFile(dir)), false, `${args.join(' ')} must not write the file`);
  }

  for (const format of ['claude-session-start', 'cursor']) {
    fs.rmSync(envFile(dir), { force: true });
    const res = forge(dir, ['reminder', '--format', format]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(envFile(dir), 'utf8'), expectedFile(TEMPLATES, 1), `--format ${format}`);
  }
});

test('writeSlotEnvFile reports what it did and never creates the file when unconfigured', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  assert.equal(writeSlotEnvFile(dir), null);
  assert.equal(fs.existsSync(envFile(dir)), false);
  writeConfig(dir, { slots: { env: TEMPLATES } });
  const first = writeSlotEnvFile(dir);
  assert.deepEqual(first, { written: true, path: envFile(dir), slot: 1 });
  const second = writeSlotEnvFile(dir);
  assert.deepEqual(second, { written: false, path: envFile(dir), slot: 1 });
});

test('writeSlotEnvFile never throws: an unwritable target warns and returns null', () => {
  const repo = makeRepo(1);
  const dir = repo.worktrees[0];
  writeConfig(dir, { slots: { env: TEMPLATES } });
  fs.mkdirSync(envFile(dir)); // a directory where the file should go
  const warnings = [];
  assert.equal(writeSlotEnvFile(dir, { warn: (m) => warnings.push(m) }), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slot\.env/);
});
