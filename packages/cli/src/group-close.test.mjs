/**
 * `forge group close` (cost-levers task 3.2): checkpoint, reviewer range,
 * precheck and label in one call, stopping at the first failing step.
 *
 * Every test drives the real bin in a throwaway git project it owns, so the
 * commits the checkpoint step makes never land in a real repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A git project on a feature branch at `implement`, with uncommitted work.
 * `spine.json` is written (not applicable) so the only integrity problems a
 * test sees are the ones it plants.
 */
function makeProject({ branch = 'feature-x', config = { git: { checkpoint: 'per-group' } }, phase = 'implement', spine = true } = {}) {
  const cwd = tmp('forge-group-close-');
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
      phase,
      planType: 'specs',
      openspecChange: 'phase-1',
      tasksTotal: 8,
      tasksComplete: 4,
      baseCommit: baseSha,
      branch,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(cwd, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  if (config) fs.writeFileSync(path.join(cwd, '.forge', 'config.json'), `${JSON.stringify(config)}\n`, 'utf8');
  if (spine) {
    fs.writeFileSync(
      path.join(sessionDir, 'spine.json'),
      JSON.stringify({ version: 1, rows: [], notApplicable: 'test fixture' }),
      'utf8',
    );
  }
  fs.appendFileSync(path.join(cwd, 'README.md'), 'edited by task 1.1\n');
  fs.writeFileSync(path.join(cwd, 'new-module.mjs'), 'export const x = 1;\n', 'utf8');
  return { cwd, sessionDir, baseSha };
}

function groupClose(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('group-close-fleet-'), 's') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [BIN, 'group', 'close', ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readSession = (sessionDir) => JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
const stampsOf = (sessionDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'reviews', 'dispatches.json'), 'utf8')).stamps;
  } catch {
    return [];
  }
};
/** The value printed on a `name:` line of the block. */
const field = (stdout, name) => new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(stdout)?.[1];

test('group close commits the group, then reports the range that covers exactly that group', () => {
  const { cwd, sessionDir, baseSha } = makeProject();

  const r = groupClose(cwd, ['--group', 'group-01', '--tasks', '1.1,1.2']);

  assert.equal(r.status, 0, r.stderr);
  const [checkpoint] = readSession(sessionDir).checkpoints;
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), checkpoint.sha, 'group 1 is committed');
  assert.equal(checkpoint.group, 'group-01');

  const target = field(r.stdout, 'reviewTarget');
  assert.equal(target, `${baseSha}..${checkpoint.sha}`);
  assert.notEqual(target, `${checkpoint.sha}..HEAD`, 'the range of a just-committed group is not the empty last..HEAD');
  assert.deepEqual(
    git(cwd, 'diff', '--name-only', target).split('\n').sort(),
    ['README.md', 'new-module.mjs'],
    'the target holds the group work',
  );

  assert.equal(field(r.stdout, 'precheck'), 'OK');
  const label = field(r.stdout, 'label');
  assert.equal(label, 'forge-review group-01 s1');
  const stamp = stampsOf(sessionDir).find((s) => s.label === label);
  assert.ok(stamp, 'the label step stamped the dispatch');
  assert.equal(field(r.stdout, 'tier'), stamp.model.tier, 'the printed tier is the one the stamp recorded');
});

test('a second group closes against the previous checkpoint, not the session base', () => {
  const { cwd, sessionDir } = makeProject();
  assert.equal(groupClose(cwd, ['--group', 'group-01']).status, 0);
  fs.writeFileSync(path.join(cwd, 'second.mjs'), 'export const y = 2;\n', 'utf8');

  const r = groupClose(cwd, ['--group', 'group-02']);

  assert.equal(r.status, 0, r.stderr);
  const [first, second] = readSession(sessionDir).checkpoints;
  const target = field(r.stdout, 'reviewTarget');
  assert.equal(target, `${first.sha}..${second.sha}`);
  assert.deepEqual(git(cwd, 'diff', '--name-only', target).split('\n'), ['second.mjs'], 'group 1 work is not in group 2 range');
});

test('with checkpoints off nothing is committed and the range is the working tree against the base', () => {
  const { cwd, sessionDir, baseSha } = makeProject({ config: { git: { checkpoint: 'off' } } });
  const head = git(cwd, 'rev-parse', 'HEAD');

  const r = groupClose(cwd, ['--group', 'group-01']);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head, 'no commit was made');
  assert.equal(readSession(sessionDir).checkpoints, undefined);
  assert.match(field(r.stdout, 'checkpoint'), /skipped/);
  assert.ok(field(r.stdout, 'reviewTarget').startsWith(`git diff ${baseSha}`));
  assert.match(field(r.stdout, 'reviewTarget'), /new-module\.mjs/, 'untracked work is named');
});

test('a failing checkpoint stops the sequence and names the step', () => {
  const { cwd, sessionDir } = makeProject({ branch: 'main' });

  const r = groupClose(cwd, ['--group', 'group-01']);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /step "checkpoint" failed/);
  assert.match(r.stderr, /default branch/);
  assert.equal(stampsOf(sessionDir).length, 0, 'the label step never ran');
  assert.equal(field(r.stdout, 'label'), undefined);
});

test('a precheck FAIL row stops the sequence after the precheck: committed, but no label', () => {
  const { cwd, sessionDir } = makeProject();
  const task = path.join(sessionDir, 'tasks', '1.1-unpaired');
  fs.mkdirSync(task, { recursive: true });
  // A green stamp with no red before it: the pairing the integrity gate demands is missing.
  fs.writeFileSync(
    path.join(task, 'tdd-runs.jsonl'),
    `${JSON.stringify({ expect: 'pass', ok: true, exit: 0, startedAt: '2026-09-04T00:00:02Z', cmd: 'node', args: ['--test', 'x.test.mjs'] })}\n`,
    'utf8',
  );

  const r = groupClose(cwd, ['--group', 'group-01']);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /step "precheck" failed/);
  assert.match(r.stderr, /1\.1-unpaired/);
  assert.equal(readSession(sessionDir).checkpoints.length, 1, 'the checkpoint step ran first');
  assert.equal(stampsOf(sessionDir).length, 0, 'the label step never ran');
});

test('integrity problems alone are informational during implement and stop the sequence from verify on', () => {
  const implement = makeProject({ spine: false });
  const early = groupClose(implement.cwd, ['--group', 'group-01']);
  assert.equal(early.status, 0, early.stderr);
  assert.match(field(early.stdout, 'precheck'), /^PROBLEMS \(\d+, informational/);
  assert.equal(field(early.stdout, 'label'), 'forge-review group-01 s1', 'the sequence went on to the label');

  const verify = makeProject({ spine: false, phase: 'verify' });
  const late = groupClose(verify.cwd, ['--group', 'group-01']);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /step "precheck" failed/);
  assert.match(late.stderr, /spine\.json required/);
  assert.equal(stampsOf(verify.sessionDir).length, 0);
});

test('a group name that is not a usable review unit fails at the label step', () => {
  const { cwd } = makeProject();

  const r = groupClose(cwd, ['--group', 'not a unit']);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /step "label" failed/);
});

test('--group is required, and only the close subcommand exists', () => {
  const { cwd } = makeProject();
  const head = git(cwd, 'rev-parse', 'HEAD');

  const noGroup = groupClose(cwd, []);
  assert.notEqual(noGroup.status, 0);
  assert.match(noGroup.stderr, /--group <name> is required/);

  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('group-close-fleet-'), 's') };
  const other = spawnSync(process.execPath, [BIN, 'group', 'open', '--group', 'g'], { cwd, env, encoding: 'utf8' });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /Usage: forge group close/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head, 'a usage error commits nothing');
});
