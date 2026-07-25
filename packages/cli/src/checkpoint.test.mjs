import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT = path.join(SRC, 'checkpoint.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Git project on a feature branch with one commit, a Forge session, and
 * uncommitted work — the shape of an implement phase at a group boundary.
 */
function makeProject({ branch = 'feature-x', config = { git: { checkpoint: 'per-group' } } } = {}) {
  const cwd = tmp('forge-ckpt-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# base\n', 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  if (branch !== 'main') git(cwd, 'checkout', '-q', '-b', branch);

  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'phase-1',
      createdAt: now,
      updatedAt: now,
      phase: 'implement',
      planType: 'specs',
      openspecChange: 'phase-1',
      tasksTotal: 8,
      tasksComplete: 4,
      baseCommit: baseSha,
      branch,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  if (config) {
    fs.writeFileSync(
      path.join(cwd, '.forge', 'config.json'),
      `${JSON.stringify(config)}\n`,
      'utf8',
    );
  }
  // Agent work: one edit, one new file.
  fs.appendFileSync(path.join(cwd, 'README.md'), 'edited by task 1.1\n');
  fs.writeFileSync(path.join(cwd, 'new-module.mjs'), 'export const x = 1;\n', 'utf8');
  return { cwd, sessionDir, baseSha };
}

function run(cwd, args = []) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('ckpt-fleet-'), 's') };
  try {
    const stdout = execFileSync(process.execPath, [CHECKPOINT, ...args], { cwd, env });
    return { status: 0, out: JSON.parse(stdout.toString()), stderr: '' };
  } catch (err) {
    let out = null;
    try {
      out = JSON.parse(String(err.stdout));
    } catch {
      /* non-JSON failure */
    }
    return { status: err.status, out, stderr: String(err.stderr) };
  }
}

function readSession(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
}

test('checkpoint commits the working tree and records the commit on the session', () => {
  const { cwd, sessionDir, baseSha } = makeProject();

  const { status, out } = run(cwd, ['--group', 'group-02-testkit', '--tasks', '2.1-2.4']);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.equal(out.committed, true);
  assert.match(out.subject, /phase-1/);
  assert.match(out.subject, /group-02-testkit/);
  // Both the edit and the untracked file are in — agent work is mostly new files.
  assert.deepEqual(out.files.sort(), ['README.md', 'new-module.mjs']);

  // Product files are all in; session scratch is deliberately left out, so a
  // checkpoint cannot bury the diff under .forge churn (or dirty the tree
  // again with its own session write).
  assert.equal(
    git(cwd, 'status', '--porcelain', '--', '.', ':(exclude).forge'),
    '',
    'no product file is left uncommitted',
  );
  assert.equal(
    git(cwd, 'show', '--name-only', '--format=', 'HEAD').split('\n').some((f) => f.startsWith('.forge')),
    false,
    'session scratch is never committed by a checkpoint',
  );
  const session = readSession(sessionDir);
  assert.equal(session.checkpoints.length, 1);
  assert.equal(session.checkpoints[0].sha, git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(session.checkpoints[0].group, 'group-02-testkit');
  assert.equal(session.checkpoints[0].tasks, '2.1-2.4');
  // The range a reviewer needs: everything this session has produced.
  assert.equal(out.range, `${baseSha}..HEAD`);
});

test('a second checkpoint reports the range covering only the new group', () => {
  const { cwd, sessionDir } = makeProject();
  const first = run(cwd, ['--group', 'group-01']);
  assert.equal(first.status, 0);

  fs.writeFileSync(path.join(cwd, 'second.mjs'), 'export const y = 2;\n', 'utf8');
  const second = run(cwd, ['--group', 'group-02']);

  assert.equal(second.status, 0);
  assert.equal(second.out.groupRange, `${first.out.sha}..${second.out.sha}`);
  assert.deepEqual(second.out.files, ['second.mjs']);
  assert.equal(readSession(sessionDir).checkpoints.length, 2);
});

test('a clean tree is not an error and creates no empty commit', () => {
  const { cwd } = makeProject();
  run(cwd, ['--group', 'group-01']);
  const head = git(cwd, 'rev-parse', 'HEAD');

  const { status, out } = run(cwd, ['--group', 'group-02']);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.equal(out.committed, false);
  assert.match(out.reason, /nothing to checkpoint/i);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head, 'no empty commit');
});

test('--dry-run reports what would be committed and commits nothing', () => {
  const { cwd, sessionDir } = makeProject();
  const head = git(cwd, 'rev-parse', 'HEAD');

  const { status, out } = run(cwd, ['--group', 'group-01', '--dry-run']);
  assert.equal(status, 0);
  assert.equal(out.committed, false);
  assert.deepEqual(out.files.sort(), ['README.md', 'new-module.mjs']);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(readSession(sessionDir).checkpoints, undefined);
});

test('checkpoints are refused on the default branch unless explicitly allowed', () => {
  // Forge work belongs on a branch; committing straight to main is the one
  // mistake an automated commit must never make on its own.
  const { cwd } = makeProject({ branch: 'main' });

  const refused = run(cwd, ['--group', 'group-01']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /default branch/i);
  assert.equal(git(cwd, 'status', '--porcelain') === '', false, 'work is left untouched');

  const allowed = run(cwd, ['--group', 'group-01', '--allow-default-branch']);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.out.committed, true);
});

test('checkpoints are off unless the project opts in', () => {
  const { cwd } = makeProject({ config: {} });
  const { status, out, stderr } = run(cwd, ['--group', 'group-01']);
  assert.equal(status, 1);
  assert.equal(out?.ok, false);
  assert.match(`${stderr}${out?.reason ?? ''}`, /checkpoint/i);
  assert.match(`${stderr}${out?.reason ?? ''}`, /git\.checkpoint/);
});

test('an in-progress merge blocks a checkpoint', () => {
  const { cwd } = makeProject();
  fs.writeFileSync(path.join(cwd, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`, 'utf8');

  const { status, stderr } = run(cwd, ['--group', 'group-01']);
  assert.equal(status, 1);
  assert.match(stderr, /merge|rebase|in progress/i);
});

test('--range --last targets the working tree while the group is still uncommitted', () => {
  // The group review runs BEFORE its checkpoint, so at review time the group's
  // work is uncommitted and HEAD is still the previous checkpoint: a
  // `<sha>..HEAD` range would be empty and the reviewer would read nothing.
  const { cwd } = makeProject();
  const first = run(cwd, ['--group', 'group-01']);
  fs.writeFileSync(path.join(cwd, 'second.mjs'), 'export const y = 2;\n', 'utf8');
  fs.appendFileSync(path.join(cwd, 'README.md'), 'more\n');

  const { status, out } = run(cwd, ['--range', '--last']);
  assert.equal(status, 0);
  assert.equal(out.base, first.out.sha);
  assert.equal(out.dirty, true);
  // Untracked files are most of what an agent writes and never appear in a
  // plain `git diff`, so they must be called out by name.
  assert.deepEqual(out.untracked, ['second.mjs']);
  assert.match(out.reviewTarget, new RegExp(`git diff ${first.out.sha}`));
  assert.match(out.reviewTarget, /second\.mjs/);
});

test('--range --last is a plain commit range once the group is checkpointed', () => {
  const { cwd } = makeProject();
  run(cwd, ['--group', 'group-01']);
  fs.writeFileSync(path.join(cwd, 'second.mjs'), 'export const y = 2;\n', 'utf8');
  const second = run(cwd, ['--group', 'group-02']);

  const { out } = run(cwd, ['--range', '--last']);
  assert.equal(out.dirty, false);
  assert.deepEqual(out.untracked, []);
  assert.equal(out.base, second.out.sha);
  assert.equal(out.reviewTarget, `${second.out.sha}..HEAD`);
});

test('--range without --last spans the whole session from its base commit', () => {
  const { cwd, baseSha } = makeProject();
  run(cwd, ['--group', 'group-01']);

  const { out } = run(cwd, ['--range']);
  assert.equal(out.base, baseSha);
  assert.equal(out.range, `${baseSha}..HEAD`);
  assert.equal(out.dirty, false);
});

test('checkpoint never pushes', () => {
  const { cwd } = makeProject();
  // A remote that would fail loudly if anything tried to reach it.
  git(cwd, 'remote', 'add', 'origin', 'file:///nonexistent-remote.git');
  const { status, out } = run(cwd, ['--group', 'group-01']);
  assert.equal(status, 0);
  assert.equal(out.committed, true);
  assert.equal(git(cwd, 'log', '--oneline', '-1', '--format=%s').includes('phase-1'), true);
});
