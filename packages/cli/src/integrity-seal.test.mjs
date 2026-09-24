import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  checkIntegritySeal,
  computeIntegrityFingerprint,
  hashFile,
  listProtectedRelPaths,
  refreshIntegritySeal,
  SEAL_BASENAME,
} from './integrity-seal.mjs';
import { runIntegrityChecks } from './integrity.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function gitRepo(prefix) {
  const dir = tmp(prefix);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'forge-test'], { cwd: dir });
  return dir;
}

function gitCommitAll(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  const result = spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
}

function gitHead(dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
}

function writeNaSpine(sessionDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    `${JSON.stringify({ rows: [], notApplicable: 'seal fixture' }, null, 2)}\n`,
    'utf8',
  );
}

function makeSealedSession(cwd) {
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  writeNaSpine(sessionDir);
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'x', phase: 'implement' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' }, null, 2)}\n`,
    'utf8',
  );
  refreshIntegritySeal({ sessionDir, repoRoot: cwd });
  return sessionDir;
}

test('hashFile is sha256 of the bytes', () => {
  const dir = tmp('seal-hash-');
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello\n', 'utf8');
  assert.equal(
    hashFile(file),
    crypto.createHash('sha256').update('hello\n').digest('hex'),
  );
});

test('listProtectedRelPaths includes untracked session.json, active.json, and session-dir artifacts', () => {
  const cwd = tmp('seal-list-');
  const sessionDir = makeSealedSession(cwd);
  const rels = listProtectedRelPaths({ repoRoot: cwd, sessionDir });
  assert.ok(rels.includes('.forge/active.json'));
  assert.ok(rels.includes('.forge/sessions/s1/session.json'));
  assert.ok(rels.includes('.forge/sessions/s1/spine.json'));
  assert.ok(!rels.some((r) => r.endsWith(SEAL_BASENAME)), 'the seal file is not sealed');
});

test('checkIntegritySeal: missing seal is not a finding (fixtures / pre-seal sessions)', () => {
  const cwd = tmp('seal-missing-');
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{}\n', 'utf8');
  assert.deepEqual(checkIntegritySeal({ cwd, sessionDir }).problems, []);
});

test('checkIntegritySeal: unreadable seal fails closed', () => {
  const cwd = tmp('seal-bad-');
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, SEAL_BASENAME), '{ not json', 'utf8');
  const { problems } = checkIntegritySeal({ cwd, sessionDir });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unreadable|malformed|integrity-seal/);
});

test('checkIntegritySeal: clean sealed session passes', () => {
  const cwd = tmp('seal-clean-');
  const sessionDir = makeSealedSession(cwd);
  assert.deepEqual(checkIntegritySeal({ cwd, sessionDir }).problems, []);
  const fp = computeIntegrityFingerprint({ repoRoot: cwd, sessionDir });
  assert.equal(typeof fp.files['.forge/sessions/s1/session.json'], 'string');
});

test('checkIntegritySeal: untracked session.json mutation is caught', () => {
  const cwd = tmp('seal-mutate-');
  const sessionDir = makeSealedSession(cwd);
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{}\n', 'utf8');
  const { problems } = checkIntegritySeal({ cwd, sessionDir });
  assert.ok(problems.some((p) => p.includes('session.json')));
  assert.match(problems.join('\n'), /mutated outside PreToolUse/);
});

test('checkIntegritySeal: untracked session artifact (spine.json) mutation is caught', () => {
  const cwd = tmp('seal-spine-');
  const sessionDir = makeSealedSession(cwd);
  fs.writeFileSync(path.join(sessionDir, 'spine.json'), '{"rows":[],"notApplicable":"pwned"}\n', 'utf8');
  const { problems } = checkIntegritySeal({ cwd, sessionDir });
  assert.ok(problems.some((p) => p.includes('spine.json')));
});

test('checkIntegritySeal: deleting a sealed path fails closed', () => {
  const cwd = tmp('seal-del-');
  const sessionDir = makeSealedSession(cwd);
  fs.rmSync(path.join(sessionDir, 'spine.json'));
  const { problems } = checkIntegritySeal({ cwd, sessionDir });
  assert.ok(problems.some((p) => /deleted/.test(p) && p.includes('spine.json')));
});

test('refreshIntegritySeal after a legitimate write clears the finding', () => {
  const cwd = tmp('seal-refresh-');
  const sessionDir = makeSealedSession(cwd);
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{"id":"s1","phase":"verify"}\n', 'utf8');
  assert.ok(checkIntegritySeal({ cwd, sessionDir }).problems.length > 0);
  refreshIntegritySeal({ sessionDir, repoRoot: cwd });
  assert.deepEqual(checkIntegritySeal({ cwd, sessionDir }).problems, []);
});

test('runIntegrityChecks: tracked guarded-test edit is still caught (git-diff path)', () => {
  const cwd = gitRepo('seal-tracked-');
  const testFile = path.join(cwd, 'a.test.mjs');
  fs.writeFileSync(testFile, 'one\n', 'utf8');
  gitCommitAll(cwd, 'base');
  const baseCommit = gitHead(cwd);
  const sessionDir = makeSealedSession(cwd);
  fs.writeFileSync(testFile, 'tampered\n', 'utf8');
  const result = runIntegrityChecks({
    cwd,
    sessionDir,
    session: { slug: 'x', openspecChange: null, baseCommit },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /a\.test\.mjs/);
});

test('runIntegrityChecks: untracked session.json mutation is caught when a seal exists', () => {
  const cwd = gitRepo('seal-untracked-');
  fs.writeFileSync(path.join(cwd, 'a.test.mjs'), 'one\n', 'utf8');
  gitCommitAll(cwd, 'base');
  const baseCommit = gitHead(cwd);
  const sessionDir = makeSealedSession(cwd);
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{}\n', 'utf8');
  const result = runIntegrityChecks({
    cwd,
    sessionDir,
    session: { slug: 'x', openspecChange: null, baseCommit },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /session\.json/);
});

test('runIntegrityChecks: sealed clean path still passes', () => {
  const cwd = gitRepo('seal-pass-');
  fs.writeFileSync(path.join(cwd, 'a.test.mjs'), 'one\n', 'utf8');
  gitCommitAll(cwd, 'base');
  const baseCommit = gitHead(cwd);
  const sessionDir = makeSealedSession(cwd);
  const result = runIntegrityChecks({
    cwd,
    sessionDir,
    session: { slug: 'x', openspecChange: null, baseCommit },
  });
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.deepEqual(result.problems, []);
});
