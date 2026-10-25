import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLedger } from './ledger.mjs';

/**
 * `forge escapes verify`: replay each pending candidate's fix test on the fix's
 * parent and on the fix, in a temp project, through the shipped bin.
 */

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const RULE = { match: 'test/**', cwd: '.', command: 'node --test {file}' };

/**
 * A done session whose change added src/add.js (with a bug), then a fix that corrects it and adds
 * `testBody(sentinel)` as test/add.test.js (`null` = the fix adds no test). Every run of the test
 * writes `sentinel`, so a run that never happened leaves no file.
 */
function project({ testBody = defaultTest, extraFixFiles = {}, replay = [RULE], escapes = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-verify-'));
  const sentinel = path.join(dir, '.forge', 'ran.txt');
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A', '--', '.', ':!.forge'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  const config = { plan: { engine: 'specs', dir: 'specs' }, escapes: { ...(replay ? { replay } : {}), ...escapes } };
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), `${JSON.stringify(config)}\n`);
  const base = commit({ 'package.json': '{"type":"module"}\n', 'README.md': 'x\n' }, 'base', T0 - DAY);
  const head = commit({ 'src/add.js': 'export const add = (a, b) => a - b;\n// pad one\n// pad two\n' }, 'feat: add', T0);
  const fix = commit(
    {
      'src/add.js': 'export const add = (a, b) => a + b;\n// pad one\n// pad two\n',
      ...(testBody ? { 'test/add.test.js': testBody(sentinel) } : {}),
      ...extraFixFiles,
    },
    'fix: add sums',
    T0 + DAY,
  );
  const row = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: new Date(T0 + 3600000).toISOString(), commitRange: { base, head } };
  fs.writeFileSync(path.join(dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-verify-fleet-'));
  return { dir, fix, sentinel, git, fleet };
}

const defaultTest = (sentinel) =>
  [
    "import fs from 'node:fs';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.js';",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran');`,
    "test('adds', () => assert.equal(add(2, 3), 5));",
    '',
  ].join('\n');

/** Run `forge escapes <args>` in the project. exec: true sets the opt-in env; otherwise it is removed. */
function forge(p, args, { exec = false } = {}) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: p.fleet };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORGEKIT_ALLOW_EXEC;
  if (exec) env.FORGEKIT_ALLOW_EXEC = '1';
  return spawnSync(process.execPath, [BIN, 'escapes', ...args], { cwd: p.dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

const ledger = (p, name) => readLedger(path.join(p.dir, '.forge', name));
const worktreeCount = (p) => p.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
const tree = (p) => p.git(['status', '--porcelain', '--', '.', ':!.forge']);
const lineFor = (p, out) => out.split('\n').find((l) => l.includes(p.fix.slice(0, 7)));

test('verify without the exec opt-in refuses and runs nothing', () => {
  const p = project();
  const r = forge(p, ['verify', '--all']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refusing to execute/);
  assert.match(r.stderr, /forge escapes verify/);
  assert.equal(fs.existsSync(p.sentinel), false, 'the test never ran');
  assert.deepEqual(ledger(p, 'escapes.jsonl'), []);
  assert.deepEqual(ledger(p, 'escape-tags.jsonl'), []);
  assert.equal(worktreeCount(p), 1, 'no worktree was created');
});

test('verify --all with FORGEKIT_ALLOW_EXEC=1 auto-confirms an escaped bug end to end', () => {
  const p = project();
  const before = tree(p);
  const r = forge(p, ['verify', '--all'], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = lineFor(p, r.stdout);
  assert.ok(line, r.stdout);
  assert.equal(line, `s1 ${p.fix.slice(0, 7)} .: confirmed (auto)`);
  assert.match(r.stdout, /1 candidate\(s\): 1 confirmed, 0 environment, 0 not-reproduced, 0 undecided/);
  assert.equal(fs.existsSync(p.sentinel), true, 'the test really ran');
  const [d, ...more] = ledger(p, 'escapes.jsonl');
  assert.equal(more.length, 0);
  assert.equal(d.decision, 'confirmed');
  assert.equal(d.auto, true);
  assert.equal(d.commit, p.fix);
  assert.equal(d.command, 'node --test test/add.test.js');
  assert.notEqual(d.oldExit, 0);
  assert.equal(d.fixExit, 0);
  assert.equal(d.replayTest, 'test/add.test.js');
  assert.equal(worktreeCount(p), 1, 'no worktree left behind');
  assert.equal(tree(p), before, 'operator working tree unchanged');
  // Decided now: a second run has nothing pending.
  const again = forge(p, ['verify', '--all'], { exec: true });
  assert.match(again.stdout, /0 candidate\(s\)/);
});

test('verify names one candidate by session and commit prefix; unknown ones are an error', () => {
  const p = project();
  const missing = forge(p, ['verify', 's1', 'deadbee'], { exec: true });
  assert.equal(missing.status, 1);
  assert.equal(fs.existsSync(p.sentinel), false);
  const r = forge(p, ['verify', 's1', p.fix.slice(0, 7)], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(lineFor(p, r.stdout)?.endsWith('confirmed (auto)'), r.stdout);
  assert.equal(forge(p, ['verify'], { exec: true }).status, 1, 'neither --all nor a candidate is a usage error');
});

test('verify --json reports each candidate and the counts', () => {
  const p = project();
  const r = forge(p, ['verify', '--all', '--json'], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map((x) => [x.session, x.commit, x.repo, x.outcome]), [['s1', p.fix, '.', 'confirmed']]);
  assert.equal(out.summary.confirmed, 1);
});

test('a candidate with no matching rule is tagged undecided: no-rule, runs nothing, and stays pending', () => {
  const p = project({ replay: [{ ...RULE, match: 'elsewhere/**' }] });
  const r = forge(p, ['verify', '--all']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lineFor(p, r.stdout), `s1 ${p.fix.slice(0, 7)} .: undecided: no-rule`);
  assert.match(r.stdout, /0 confirmed, 0 environment, 0 not-reproduced, 1 undecided/);
  assert.equal(fs.existsSync(p.sentinel), false);
  assert.deepEqual(ledger(p, 'escapes.jsonl'), []);
  const list = forge(p, ['list']);
  assert.match(lineFor(p, list.stdout) ?? '', /undecided: no-rule/);
});

test('a fix that added no test is tagged undecided: no-test', () => {
  const p = project({ testBody: null });
  const r = forge(p, ['verify', '--all']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lineFor(p, r.stdout), `s1 ${p.fix.slice(0, 7)} .: undecided: no-test`);
  assert.deepEqual(ledger(p, 'escape-tags.jsonl').map((t) => [t.tag, t.reason]), [['undecided', 'no-test']]);
});

test('a test that needs code the fix added is tagged environment, not confirmed', () => {
  const p = project({
    testBody: (sentinel) =>
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { helper } from '../src/helper.js';",
        `void ${JSON.stringify(sentinel)};`,
        "test('uses the new helper', () => assert.equal(helper(), 1));",
        '',
      ].join('\n'),
    extraFixFiles: { 'src/helper.js': 'export const helper = () => 1;\n' },
  });
  const r = forge(p, ['verify', '--all'], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lineFor(p, r.stdout), `s1 ${p.fix.slice(0, 7)} .: environment`);
  assert.deepEqual(ledger(p, 'escapes.jsonl'), []);
  assert.deepEqual(ledger(p, 'escape-tags.jsonl').map((t) => t.tag), ['environment']);
});

test('a test that also passes on the old code is tagged not-reproduced', () => {
  const p = project({
    testBody: () => ["import test from 'node:test';", "test('trivially true', () => {});", ''].join('\n'),
  });
  const r = forge(p, ['verify', '--all'], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lineFor(p, r.stdout), `s1 ${p.fix.slice(0, 7)} .: not-reproduced`);
  assert.deepEqual(ledger(p, 'escapes.jsonl'), []);
});

test('escapes.replayTimeoutSec bounds a hung replay: undecided: timeout, nothing left behind', () => {
  const p = project({
    testBody: () => ["import test from 'node:test';", "test('hangs', () => new Promise(() => setInterval(() => {}, 1000)));", ''].join('\n'),
    escapes: { replayTimeoutSec: 2 },
  });
  const r = forge(p, ['verify', '--all'], { exec: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lineFor(p, r.stdout), `s1 ${p.fix.slice(0, 7)} .: undecided: timeout`);
  assert.equal(worktreeCount(p), 1);
  assert.deepEqual(ledger(p, 'escapes.jsonl'), []);
});
