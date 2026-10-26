import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runReplay } from './escapes-replay.mjs';

/**
 * Where replay worktrees live: `<project's parent>/forge-replay-<project>/`, on the project's drive,
 * with no dot segment. Live checks on Volo, 2026-10-25/26: in the OS temp dir on another drive,
 * Vite/esbuild could not load its config; inside `.git`, Vite's `server.fs.deny` refused every file;
 * under `.forge/replay`, Jest on Windows read `\.forge` in its testMatch glob as an escaped dot and
 * found no tests.
 */

const PROBE = "console.log('cwd=' + process.cwd());\n";

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
  return { dir, commit };
}

function fixture(nestedAs) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'forge-replay-loc-')));
  const repo = repoAt(nestedAs ? path.join(root, nestedAs) : root);
  if (nestedAs) repoAt(root).commit({ '.gitignore': `${nestedAs}/\n` }, 'root');
  repo.commit({ 'README.md': 'x\n' }, 'base');
  const probeSha = repo.commit({ 'test/probe.js': PROBE }, 'probe');
  return { root, repo, probeSha };
}

const status = (dir) => execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: dir, encoding: 'utf8' });
const worktrees = (dir) =>
  execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

for (const nestedAs of [null, 'app']) {
  test(`replay worktrees live in a sibling forge-replay-<project> dir with no dot segment, and nothing is left (${nestedAs ?? 'root repo'})`, async () => {
    const f = fixture(nestedAs);
    const before = status(f.root);
    const res = await runReplay({
      projectRoot: f.root,
      repo: nestedAs ?? '.',
      fixSha: f.probeSha,
      testPath: 'test/probe.js',
      rule: { match: '**', cwd: nestedAs ?? '.', command: 'node {file}' },
    });
    const base = path.join(path.dirname(f.root), `forge-replay-${path.basename(f.root)}`);
    for (const run of [res.old, res.fix]) {
      assert.equal(run.exit, 0, run.output);
      const cwd = /cwd=(.*)/.exec(run.output)?.[1]?.trim();
      assert.ok(cwd, run.output);
      const real = path.resolve(cwd);
      assert.ok(real.toLowerCase().startsWith(base.toLowerCase() + path.sep), `${real} is not under ${base}`);
      // Jest on Windows turns `\.name` in its rootDir-based testMatch into an escaped dot.
      const below = path.relative(path.dirname(f.root), real).split(/[\\/]/);
      assert.ok(!below.some((seg) => seg.startsWith('.')), `${real} has a dot segment below the project's parent`);
    }
    assert.equal(fs.existsSync(base), false, 'the sibling replay dir is removed after the run');
    assert.equal(fs.existsSync(path.join(f.root, '.forge', 'replay')), false, 'nothing created inside the project');
    assert.equal(status(f.root), before, 'git status --ignored unchanged');
    assert.equal(worktrees(f.repo.dir).length, 1);
  });
}
