import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLedger } from './ledger.mjs';
import { isFixCommit } from './escapes.mjs';

/**
 * An Escape is a fix or revert commit (CONTEXT.md). On Volo, `forge escapes verify` auto-confirmed
 * 233 `feat` commits: a later feature that touches a change's lines and adds a test for new behavior
 * also fails before and passes after. Only a fix/revert may be auto-confirmed; anything else is
 * tagged `not-a-fix`, left undecided, and its test is not run.
 */

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

function project(laterSubject) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-verify-fixonly-'));
  const sentinel = path.join(dir, '.forge', 'ran.txt');
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git(['config', k, v]);
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
  const config = { plan: { engine: 'specs', dir: 'specs' }, escapes: { replay: [{ match: 'test/**', cwd: '.', command: 'node --test {file}' }] } };
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), `${JSON.stringify(config)}\n`);
  const base = commit({ 'package.json': '{"type":"module"}\n', 'README.md': 'x\n' }, 'base', T0 - DAY);
  const head = commit({ 'src/add.js': 'export const add = (a, b) => a - b;\n// pad one\n// pad two\n' }, 'feat: add', T0);
  const testBody = [
    "import fs from 'node:fs';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.js';",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran');`,
    "test('adds', () => assert.equal(add(2, 3), 5));",
    '',
  ].join('\n');
  const later = commit(
    { 'src/add.js': 'export const add = (a, b) => a + b;\n// pad one\n// pad two\n', 'test/add.test.js': testBody },
    laterSubject,
    T0 + DAY,
  );
  const row = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: new Date(T0 + 3600000).toISOString(), commitRange: { base, head } };
  fs.writeFileSync(path.join(dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-verify-fixonly-fleet-'));
  return { dir, later, sentinel, fleet };
}

function verify(p) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: p.fleet, FORGEKIT_ALLOW_EXEC: '1' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [BIN, 'escapes', 'verify', '--all'], { cwd: p.dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

const ledger = (p, name) => readLedger(path.join(p.dir, '.forge', name));

test('isFixCommit: fix/revert conventional subjects and git reverts only', () => {
  for (const s of ['fix: a', 'fix(auth): a', 'Fix(auth)!: a', 'revert: a', 'revert(x): a', 'Revert "feat: add"']) {
    assert.equal(isFixCommit(s), true, s);
  }
  for (const s of ['feat: a', 'feat(fix): a', 'perf: a', 'refactor: fix a thing', 'client: fix a', 'fixup! x', 'prefix: a', '', null, undefined]) {
    assert.equal(isFixCommit(s), false, String(s));
  }
});

test('a feature commit that touches the change is tagged not-a-fix, left undecided, and its test never runs', () => {
  const p = project('feat: add sums properly');
  const r = verify(p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${p.later.slice(0, 7)} \\.: not-a-fix`));
  assert.match(r.stdout, /1 not a fix/);
  assert.deepEqual(ledger(p, 'escapes.jsonl'), [], 'nothing confirmed');
  const tags = ledger(p, 'escape-tags.jsonl');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag, 'not-a-fix');
  assert.equal(fs.existsSync(p.sentinel), false, 'the replay test never ran');
});

for (const subject of ['fix: add sums', 'Revert "feat: add"']) {
  test(`a ${subject.split(/[:"]/)[0].trim()} commit is still auto-confirmed`, () => {
    const p = project(subject);
    const r = verify(p);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${p.later.slice(0, 7)} \\.: confirmed \\(auto\\)`));
    const [d] = ledger(p, 'escapes.jsonl');
    assert.equal(d.decision, 'confirmed');
    assert.equal(d.auto, true);
  });
}
