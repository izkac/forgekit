import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLedger } from './ledger.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Scratch git repo with two commits and a session whose baseCommit is the first. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-commit-range-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'commit', '-qam', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');

  const id = 'sess-range';
  const sessionDir = path.join(dir, '.forge', 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({ id, slug: 'range', createdAt: now, updatedAt: now, phase: 'review', baseCommit: base, tasksTotal: 0, tasksComplete: 0 }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: id })}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-commit-range-fleet-'));
  return { dir, base, head, id, sessionFile, fleet };
}

function run(f, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: f.fleet };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.dir, encoding: 'utf8', env });
}

function fleetEntry(f) {
  const file = fs.readdirSync(f.fleet).find((n) => n.endsWith(`--${f.id}.json`));
  return file ? JSON.parse(fs.readFileSync(path.join(f.fleet, file), 'utf8')) : null;
}

test('done records the commit range on the session, the digest row and the fleet entry', () => {
  const f = fixture();
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);

  const expected = { base: f.base, head: f.head };
  assert.deepEqual(JSON.parse(fs.readFileSync(f.sessionFile, 'utf8')).commitRange, expected);
  const row = readLedger(path.join(f.dir, '.forge', 'sessions.jsonl')).find((e) => e.sessionId === f.id);
  assert.deepEqual(row?.commitRange, expected);
  assert.deepEqual(fleetEntry(f)?.commitRange, expected);
});

test('a refused done records no commit range', () => {
  const f = fixture();
  const r = run(f, ['done']); // no verify evidence, no spine → refused
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.sessionFile, 'utf8')).commitRange, undefined);
});

test('a session without baseCommit gets no commit range', () => {
  const f = fixture();
  const s = JSON.parse(fs.readFileSync(f.sessionFile, 'utf8'));
  delete s.baseCommit;
  fs.writeFileSync(f.sessionFile, `${JSON.stringify(s, null, 2)}\n`);
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.sessionFile, 'utf8')).commitRange, undefined);
});

test('non-done transitions record no commit range', () => {
  const f = fixture();
  const r = run(f, ['verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.sessionFile, 'utf8')).commitRange, undefined);
});
