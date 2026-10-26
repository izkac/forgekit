import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLedger } from './ledger.mjs';

/**
 * At `done`, beside the root `commitRange`, the session records
 * `nestedCommitRanges: { "<repo>": { base, head } }` for each repo in
 * `nestedBaseCommits` whose HEAD moved. It reaches the digest row and the
 * fleet entry the same way `commitRange` does.
 */

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return git(dir, 'rev-parse', 'HEAD');
}

/** Commit one more line in `dir`; returns the new HEAD. */
function advance(dir) {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-qam', 'change');
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A project repo with nested repos `moved` (committed in during the session),
 * `still` (untouched) and `gone` (deleted before done), recorded in
 * `nestedBaseCommits` the way `forge new` records them.
 */
function fixture({ withNested = true } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-nested-ranges-'));
  const rootBase = initRepo(dir);
  advance(dir);

  const nestedBaseCommits = {};
  const heads = {};
  if (withNested) {
    for (const name of ['moved', 'still', 'gone']) nestedBaseCommits[name] = initRepo(path.join(dir, name));
    heads.moved = advance(path.join(dir, 'moved'));
    fs.rmSync(path.join(dir, 'gone'), { recursive: true, force: true });
  }

  const id = 'sess-nested';
  const sessionDir = path.join(dir, '.forge', 'sessions', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const sessionFile = path.join(sessionDir, 'session.json');
  const session = { id, slug: 'nested', createdAt: now, updatedAt: now, phase: 'review', baseCommit: rootBase, tasksTotal: 0, tasksComplete: 0 };
  if (withNested) session.nestedBaseCommits = nestedBaseCommits;
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: id })}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-nested-ranges-fleet-'));
  return { dir, id, sessionFile, fleet, nestedBaseCommits, heads };
}

function run(f, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: f.fleet };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.dir, encoding: 'utf8', env });
}

const readSession = (f) => JSON.parse(fs.readFileSync(f.sessionFile, 'utf8'));

function fleetEntry(f) {
  const file = fs.readdirSync(f.fleet).find((n) => n.endsWith(`--${f.id}.json`));
  return file ? JSON.parse(fs.readFileSync(path.join(f.fleet, file), 'utf8')) : null;
}

test('done records a range for a nested repo whose HEAD moved, and nothing for one that did not', () => {
  const f = fixture();
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);

  const expected = { moved: { base: f.nestedBaseCommits.moved, head: f.heads.moved } };
  assert.notEqual(expected.moved.base, expected.moved.head, 'the fixture must actually move the repo');
  assert.deepEqual(readSession(f).nestedCommitRanges, expected);
  const row = readLedger(path.join(f.dir, '.forge', 'sessions.jsonl')).find((e) => e.sessionId === f.id);
  assert.deepEqual(row?.nestedCommitRanges, expected);
  assert.deepEqual(fleetEntry(f)?.nestedCommitRanges, expected);
});

test('a nested repo that is gone is skipped with one stderr note; the others are still recorded', () => {
  const f = fixture();
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal('gone' in readSession(f).nestedCommitRanges, false);
  const notes = r.stderr.split('\n').filter((l) => l.includes('gone'));
  assert.equal(notes.length, 1, r.stderr);
  assert.ok(Object.keys(readSession(f).nestedCommitRanges).includes('moved'));
});

test('a session with no nested repos records an empty nestedCommitRanges', () => {
  const f = fixture({ withNested: false });
  const r = run(f, ['done', '--allow-incomplete', 'fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readSession(f).nestedCommitRanges, {});
});

test('a refused done and a non-done transition record no nested ranges', () => {
  const f = fixture();
  assert.notEqual(run(f, ['done']).status, 0);
  assert.equal(readSession(f).nestedCommitRanges, undefined);
  const r = run(f, ['verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readSession(f).nestedCommitRanges, undefined);
});
