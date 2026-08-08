import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Task 5.2 — sessions created by `forge new` from this version onward carry
 * `features.tddEvidence: true` (design D6), the flag the pairing gate in
 * `integrity.mjs` reads. Old sessions never gain this key retroactively —
 * they are simply never rewritten by `forge new`, so the exemption is
 * structural, not a special case in this test.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const NEW_SESSION_CLI = path.join(SRC, 'new-session.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare git repo `forge new` can run against, mirroring tdd-run.test.mjs's makeProject. */
function makeRepo(prefix) {
  const root = tmp(prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function runNewSession(cwd, args) {
  return spawnSync(process.execPath, [NEW_SESSION_CLI, ...args], { cwd, encoding: 'utf8' });
}

function readSessionJson(root, sessionId) {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.forge', 'sessions', sessionId, 'session.json'), 'utf8'),
  );
}

test('forge new: writes features.tddEvidence: true onto the created session', () => {
  const root = makeRepo('new-session-flag-');
  const r = runNewSession(root, ['flag-fixture']);
  assert.equal(r.status, 0, r.stderr);
  const { sessionId } = JSON.parse(r.stdout);
  const session = readSessionJson(root, sessionId);
  assert.deepEqual(session.features, { tddEvidence: true });
});

test('forge new: does not rewrite an already-existing session (no retroactive flag)', () => {
  // A session created before this feature existed — no `features` key at all.
  // `forge new` must never touch a session it did not just create.
  const root = makeRepo('new-session-legacy-');
  const legacyId = '20260101T000000Z-legacy-abcdef';
  const legacyDir = path.join(root, '.forge', 'sessions', legacyId);
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacySession = { id: legacyId, slug: 'legacy', phase: 'implement' };
  fs.writeFileSync(path.join(legacyDir, 'session.json'), `${JSON.stringify(legacySession)}\n`, 'utf8');

  const r = runNewSession(root, ['second-fixture']);
  assert.equal(r.status, 0, r.stderr);

  const untouched = JSON.parse(fs.readFileSync(path.join(legacyDir, 'session.json'), 'utf8'));
  assert.equal(untouched.features, undefined);
});
