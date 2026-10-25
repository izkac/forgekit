import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveReplayRule, runReplay } from './escapes-replay.mjs';

/**
 * Replay runner: the fix's test run twice in throwaway worktrees — on the fix's
 * parent (with the fix's test copied in) and on the fix — without ever touching
 * the operator's working tree.
 */

const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const ADD_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/add.js';",
  "test('adds', () => assert.equal(add(2, 3), 5));",
  '',
].join('\n');
const MARKER = 'marker-from-operator-node-modules';

/** A git repo at `dir` (created if missing). */
function repoAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  const commit = (files, subject) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git('add', '-A');
    git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

/**
 * The project repo sits at `<root>` (repo ".") or, for `nestedAs`, at `<root>/<nestedAs>`.
 * History: a buggy add.js, then a fix that also adds test/add.test.js, then a probe script
 * that prints the operator's node_modules marker. `node_modules` is gitignored and holds the marker.
 */
function fixture({ nestedAs = null } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forge-replay-'));
  const repo = repoAt(nestedAs ? path.join(root, nestedAs) : root);
  repo.commit({ '.gitignore': 'node_modules/\n', 'package.json': '{"type":"module"}\n', 'src/add.js': BUGGY }, 'base');
  const nm = path.join(repo.dir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'marker.txt'), MARKER);
  const fixSha = repo.commit({ 'src/add.js': FIXED, 'test/add.test.js': ADD_TEST }, 'fix: add');
  const probeSha = repo.commit({ 'test/probe.js': "import fs from 'node:fs';\nconsole.log(fs.readFileSync('node_modules/marker.txt', 'utf8'));\n" }, 'probe');
  return { root, repo, fixSha, probeSha, repoName: nestedAs ?? '.' };
}

const status = (dir) => execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: dir, encoding: 'utf8' });
const worktrees = (dir) =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

/** Point os.tmpdir() at an empty directory for the duration of a call, so leftovers are countable. */
function privateTmp() {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'forge-replay-scratch-'));
  const keys = ['TMPDIR', 'TEMP', 'TMP'];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = scratch;
  const restore = () => keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  return { scratch, restore };
}

const RULE = { match: 'test/**', cwd: '.', command: 'node --test {file}' };

test('resolveReplayRule: first matching rule wins and match is over the project-root-relative path', () => {
  const config = {
    escapes: {
      replay: [
        { match: 'volo_web/server/**', cwd: 'volo_web/server', command: 'node --test {file}' },
        { match: 'volo_web/**', cwd: 'volo_web', command: 'npm test -- {file}' },
        { match: '**', cwd: '.', command: 'catch-all {file}' },
      ],
    },
  };
  assert.equal(resolveReplayRule(config, 'volo_web/server/test/a.test.js').cwd, 'volo_web/server');
  assert.equal(resolveReplayRule(config, 'volo_web/web/test/a.test.js').command, 'npm test -- {file}');
  assert.equal(resolveReplayRule(config, 'tools/a.test.js').command, 'catch-all {file}');
});

test('resolveReplayRule: missing, malformed or non-matching config yields no rule', () => {
  const rule = { match: 'a/**', cwd: '.', command: 'node {file}' };
  assert.equal(resolveReplayRule({}, 'a/x.js'), null);
  assert.equal(resolveReplayRule({ escapes: {} }, 'a/x.js'), null);
  assert.equal(resolveReplayRule({ escapes: { replay: 'node' } }, 'a/x.js'), null);
  assert.equal(resolveReplayRule({ escapes: { replay: [rule] } }, 'b/x.js'), null);
  assert.equal(resolveReplayRule({ escapes: { replay: [{ match: 'a/**', cwd: '.' }] } }, 'a/x.js'), null, 'no command');
  assert.equal(resolveReplayRule({ escapes: { replay: [{ ...rule, command: 'node x.js' }] } }, 'a/x.js'), null, 'no {file}');
  assert.equal(resolveReplayRule({ escapes: { replay: [null, 7, rule] } }, 'a/x.js')?.command, rule.command, 'junk entries are skipped');
  assert.equal(resolveReplayRule(null, 'a/x.js'), null);
});

test('old run fails on the fix parent with the fix test copied in; fix run passes; nothing left behind', async () => {
  const f = fixture();
  const before = status(f.repo.dir);
  const res = await runReplay({ projectRoot: f.root, repo: '.', fixSha: f.fixSha, testPath: 'test/add.test.js', rule: RULE });
  assert.notEqual(res.old.exit, 0, res.old.output);
  assert.equal(res.old.timedOut, false);
  assert.equal(res.fix.exit, 0, res.fix.output);
  assert.match(res.old.output, /add/);
  assert.equal(worktrees(f.repo.dir).length, 1, 'only the main worktree remains');
  assert.equal(status(f.repo.dir), before, 'operator working tree unchanged');
});

test('a command that cannot start still cleans up', async () => {
  const f = fixture();
  const before = status(f.repo.dir);
  const res = await runReplay({
    projectRoot: f.root,
    repo: '.',
    fixSha: f.fixSha,
    testPath: 'test/add.test.js',
    rule: { ...RULE, command: 'definitely-not-a-binary-xyz {file}' },
  });
  assert.equal(res.old.exit, null);
  assert.notEqual(res.old.output, '');
  assert.equal(worktrees(f.repo.dir).length, 1);
  assert.equal(status(f.repo.dir), before);
});

test('node_modules at the rule cwd is linked in, and removing the link first leaves the operator copy intact', async () => {
  const f = fixture();
  const { scratch, restore } = privateTmp();
  let res;
  try {
    res = await runReplay({
      projectRoot: f.root,
      repo: '.',
      fixSha: f.probeSha,
      testPath: 'test/probe.js',
      rule: { match: 'test/**', cwd: '.', command: 'node {file}' },
    });
  } finally {
    restore();
  }
  assert.deepEqual(fs.readdirSync(scratch), [], 'no temp directory left behind');
  assert.equal(res.old.exit, 0, res.old.output);
  assert.equal(res.fix.exit, 0, res.fix.output);
  assert.ok(res.old.output.includes(MARKER), 'old worktree sees the linked node_modules');
  assert.ok(res.fix.output.includes(MARKER), 'fix worktree sees the linked node_modules');
  assert.equal(fs.readFileSync(path.join(f.repo.dir, 'node_modules', 'marker.txt'), 'utf8'), MARKER, 'link target survives cleanup');
  assert.equal(worktrees(f.repo.dir).length, 1);
});

test('a hung run is killed at the timeout, reported as timedOut, and cleaned up', async () => {
  const f = fixture();
  const hang = f.repo.commit({ 'test/hang.js': 'setInterval(() => {}, 1000);\n' }, 'hang');
  const before = status(f.repo.dir);
  const t0 = Date.now();
  const res = await runReplay({
    projectRoot: f.root,
    repo: '.',
    fixSha: hang,
    testPath: 'test/hang.js',
    rule: { match: 'test/**', cwd: '.', command: 'node {file}' },
    timeoutSec: 1,
  });
  assert.equal(res.old.timedOut, true);
  assert.ok(Date.now() - t0 < 30000, 'did not wait out the hang');
  assert.equal(worktrees(f.repo.dir).length, 1);
  assert.equal(status(f.repo.dir), before);
});

test('a nested repository: root-relative rule cwd, {file} relative to it, worktree of the nested repo', async () => {
  const f = fixture({ nestedAs: 'volo_web' });
  const before = status(f.repo.dir);
  const res = await runReplay({
    projectRoot: f.root,
    repo: 'volo_web',
    fixSha: f.fixSha,
    testPath: 'test/add.test.js',
    rule: { match: 'volo_web/test/**', cwd: 'volo_web', command: 'node --test {file}' },
  });
  assert.notEqual(res.old.exit, 0, res.old.output);
  assert.equal(res.fix.exit, 0, res.fix.output);
  assert.equal(worktrees(f.repo.dir).length, 1);
  assert.equal(status(f.repo.dir), before);
});

test('a rule cwd outside the repository is refused before anything is created', async () => {
  const f = fixture({ nestedAs: 'volo_web' });
  await assert.rejects(
    runReplay({ projectRoot: f.root, repo: 'volo_web', fixSha: f.fixSha, testPath: 'test/add.test.js', rule: { ...RULE, cwd: 'elsewhere' } }),
    /outside/,
  );
  assert.equal(worktrees(f.repo.dir).length, 1);
});
