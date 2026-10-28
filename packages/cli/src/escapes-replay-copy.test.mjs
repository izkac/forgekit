import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveReplayRule, runReplay } from './escapes-replay.mjs';

/**
 * `copy` on a replay rule: gitignored files (e.g. `server/.env`) a test needs are copied from the
 * operator's working copy into each throwaway worktree. On Volo 248 server replays failed on the
 * fix as well because the worktree had no `.env`.
 */

const SECRET = 'secret-from-operator-env';
const PROBE = "import fs from 'node:fs';\nconsole.log('env=' + fs.readFileSync('.env', 'utf8').trim());\n";

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'forge-replay-copy-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git('config', k, v);
  const commit = (files, subject) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    git('add', '-A');
    git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  commit({ '.gitignore': '.env\n', 'package.json': '{"type":"module"}\n' }, 'base');
  fs.writeFileSync(path.join(root, '.env'), `${SECRET}\n`);
  const probeSha = commit({ 'test/probe.js': PROBE }, 'fix: probe');
  return { root, probeSha };
}

test('resolveReplayRule keeps a copy list of paths inside the rule cwd and drops unsafe entries', () => {
  const config = { escapes: { replay: [{ match: 'test/**', cwd: '.', command: 'node {file}', copy: ['.env', 'config/local.json', '../outside', '/etc/passwd', 'C:\\x', 42] }] } };
  const rule = resolveReplayRule(config, 'test/a.js');
  assert.deepEqual(rule.copy, ['.env', 'config/local.json']);
  const plain = resolveReplayRule({ escapes: { replay: [{ match: 'test/**', command: 'node {file}' }] } }, 'test/a.js');
  assert.deepEqual(plain.copy, []);
});

test('copied ignored files reach both runs, the operator copy is untouched, and nothing is left behind', async () => {
  const f = fixture();
  const res = await runReplay({
    projectRoot: f.root,
    repo: '.',
    fixSha: f.probeSha,
    testPath: 'test/probe.js',
    rule: { match: 'test/**', cwd: '.', command: 'node {file}', copy: ['.env'] },
  });
  for (const run of [res.old, res.fix]) {
    assert.equal(run.exit, 0, run.output);
    assert.match(run.output, new RegExp(`env=${SECRET}`));
  }
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), `${SECRET}\n`, 'operator .env unchanged');
  const base = path.join(f.root, '.forge', 'replay');
  assert.ok(!fs.existsSync(base) || fs.readdirSync(base).every((n) => n === '.gitignore'), 'no worktree (or copied .env) left');
});

test('a copy entry missing from the working copy is skipped, not an error', async () => {
  const f = fixture();
  fs.rmSync(path.join(f.root, '.env'));
  const res = await runReplay({
    projectRoot: f.root,
    repo: '.',
    fixSha: f.probeSha,
    testPath: 'test/probe.js',
    rule: { match: 'test/**', cwd: '.', command: 'node {file}', copy: ['.env'] },
  });
  assert.notEqual(res.fix.exit, 0, 'the probe fails without .env, but the replay itself ran');
});
