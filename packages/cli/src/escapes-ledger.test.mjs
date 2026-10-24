import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decide, readDecisions, replayTestFor } from './escapes.mjs';

const MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'escapes.mjs')).href;

function repo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-ledger-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const commit = (files, subject) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git('add', '-A');
    git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  const plain = commit({ 'src/a.js': '1\n' }, 'fix without a test');
  const withTest = commit({ 'src/a.js': '2\n', 'test/a.test.js': 'assert\n' }, 'fix with a test');
  return { dir, plain, withTest };
}

const ledger = (r) => readDecisions(r.dir);

test('replayTestFor returns the test file a commit touched, or null', () => {
  const r = repo();
  assert.equal(replayTestFor({ cwd: r.dir, commit: r.withTest }), 'test/a.test.js');
  assert.equal(replayTestFor({ cwd: r.dir, commit: r.plain }), null);
});

test('confirm without --test takes the fix commit\'s own test', () => {
  const r = repo();
  const res = decide({ cwd: r.dir, sessionId: 's1', commit: r.withTest, decision: 'confirmed' });
  assert.equal(res.ok, true, res.error);
  const [line] = ledger(r);
  assert.equal(line.decision, 'confirmed');
  assert.equal(line.replayTest, 'test/a.test.js');
  assert.equal(line.commit, r.withTest);
  assert.equal(line.sessionId, 's1');
});

test('confirm with no test anywhere refuses and writes nothing', () => {
  const r = repo();
  const res = decide({ cwd: r.dir, sessionId: 's1', commit: r.plain, decision: 'confirmed' });
  assert.equal(res.ok, false);
  assert.match(res.error, /--test/);
  assert.deepEqual(ledger(r), []);
});

test('confirm with a --test path that exists nowhere refuses', () => {
  const r = repo();
  const res = decide({ cwd: r.dir, sessionId: 's1', commit: r.plain, decision: 'confirmed', replayTest: 'test/nope.test.js' });
  assert.equal(res.ok, false);
  assert.deepEqual(ledger(r), []);
});

test('confirm with an operator-written test on disk is accepted', () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'test', 'replay.test.js'), 'x\n');
  const res = decide({ cwd: r.dir, sessionId: 's1', commit: r.plain, decision: 'confirmed', replayTest: 'test/replay.test.js' });
  assert.equal(res.ok, true, res.error);
  assert.equal(ledger(r)[0].replayTest, 'test/replay.test.js');
});

test('dismiss needs no test; a short sha resolves; a re-decision replaces the line', () => {
  const r = repo();
  assert.equal(decide({ cwd: r.dir, sessionId: 's1', commit: r.plain.slice(0, 8), decision: 'dismissed', reason: 'refactor' }).ok, true);
  assert.deepEqual(ledger(r).map((l) => [l.commit, l.decision, l.reason]), [[r.plain, 'dismissed', 'refactor']]);
  fs.mkdirSync(path.join(r.dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'test', 'r.test.js'), 'x\n');
  assert.equal(decide({ cwd: r.dir, sessionId: 's1', commit: r.plain, decision: 'confirmed', replayTest: 'test/r.test.js' }).ok, true);
  assert.deepEqual(ledger(r).map((l) => l.decision), ['confirmed']);
});

test('an unknown commit or decision refuses', () => {
  const r = repo();
  assert.equal(decide({ cwd: r.dir, sessionId: 's1', commit: 'deadbeef', decision: 'dismissed' }).ok, false);
  assert.equal(decide({ cwd: r.dir, sessionId: 's1', commit: r.plain, decision: 'maybe' }).ok, false);
});

test('concurrent writers keep every line', async () => {
  const r = repo();
  const code = (session) =>
    `import(${JSON.stringify(MODULE)}).then((m) => { const res = m.decide({ cwd: ${JSON.stringify(r.dir)}, sessionId: ${JSON.stringify(session)}, commit: ${JSON.stringify(r.plain)}, decision: 'dismissed' }); if (!res.ok) process.exit(1); })`;
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const codes = await Promise.all(
    ids.map(
      (id) =>
        new Promise((resolve) => {
          spawn(process.execPath, ['--input-type=module', '-e', code(id)], { stdio: 'ignore' }).on('close', resolve);
        }),
    ),
  );
  assert.deepEqual(codes, ids.map(() => 0));
  assert.deepEqual(ledger(r).map((l) => l.sessionId).sort(), ids);
});
