import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runReplay } from './escapes-replay.mjs';

/**
 * Where replay worktrees live. Under the OS temp dir, Vite/Vitest projects on another drive
 * failed to load their config (esbuild walked into an unreadable parent), and inside `.git`
 * Vite's `server.fs.deny` (`**\/.git/**`) refused every file. Live check on Volo, 2026-10-25.
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
  test(`replay worktrees live under <project>/.forge/replay with no .git segment, and nothing is left (${nestedAs ?? 'root repo'})`, async () => {
    const f = fixture(nestedAs);
    const before = status(f.root);
    const res = await runReplay({
      projectRoot: f.root,
      repo: nestedAs ?? '.',
      fixSha: f.probeSha,
      testPath: 'test/probe.js',
      rule: { match: '**', cwd: nestedAs ?? '.', command: 'node {file}' },
    });
    const base = path.join(f.root, '.forge', 'replay');
    for (const run of [res.old, res.fix]) {
      assert.equal(run.exit, 0, run.output);
      const cwd = /cwd=(.*)/.exec(run.output)?.[1]?.trim();
      assert.ok(cwd, run.output);
      const real = path.resolve(cwd);
      assert.ok(real.toLowerCase().startsWith(base.toLowerCase() + path.sep), `${real} is not under ${base}`);
      assert.ok(!real.split(/[\\/]/).includes('.git'), `${real} has a .git segment`);
    }
    assert.ok(!fs.existsSync(base) || fs.readdirSync(base).every((n) => n === '.gitignore'), 'no worktree left under .forge/replay');
    assert.equal(status(f.root), before, 'git status --ignored unchanged');
    assert.equal(worktrees(f.repo.dir).length, 1);
  });
}
