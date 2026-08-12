import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { otherOpenChangeDirs, classifyPendingEntries } from './checkpoint.mjs';

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

test('untracked sibling change dir refuses; same-change untracked still commits', () => {
  // F72: git add -A would sweep another change's untracked files into this
  // session's checkpoint. Refuse instead; own-change untracked is fine.
  const { cwd } = makeProject({
    config: {
      git: { checkpoint: 'per-group' },
      plan: { engine: 'specs', dir: 'specs' },
    },
  });
  const foreign = path.join(cwd, 'specs', 'changes', 'other-change', 'proposal.md');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, '# other\n', 'utf8');
  const headBefore = git(cwd, 'rev-parse', 'HEAD');

  const refused = run(cwd, ['--group', 'group-01']);
  assert.equal(refused.status, 1);
  assert.match(`${refused.stderr}${refused.out ? JSON.stringify(refused.out) : ''}`, /other-change/);
  assert.match(`${refused.stderr}${refused.out ? JSON.stringify(refused.out) : ''}`, /specs\/changes\/other-change/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), headBefore, 'no commit on refuse');
  assert.equal(
    git(cwd, 'status', '--porcelain', '--', 'specs/changes/other-change').includes('??'),
    true,
    'foreign untracked left untouched',
  );

  fs.rmSync(path.join(cwd, 'specs', 'changes', 'other-change'), { recursive: true, force: true });
  const own = path.join(cwd, 'specs', 'changes', 'phase-1', 'note.md');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '# own\n', 'utf8');

  const ok = run(cwd, ['--group', 'group-01']);
  assert.equal(ok.status, 0);
  assert.equal(ok.out.committed, true);
  assert.ok(ok.out.files.includes('specs/changes/phase-1/note.md'));
});

/**
 * `.forge/sessions/` + a plan dir shaped for `otherOpenChangeDirs`: this
 * session, two other open sessions (different phases, both with a change dir
 * that exists on disk), a done session, a skipped session, an open session
 * whose change dir was never created, and a malformed `session.json` — every
 * reason an entry must be excluded, each represented once so the test can
 * tell "excluded for the right reason" from "excluded by accident".
 */
function makeOtherSessionsFixture() {
  const root = tmp('forge-ckpt-other-');
  const sessionsDir = path.join(root, '.forge', 'sessions');
  const planDir = path.join(root, 'specs');
  const thisId = 'this-session';

  const writeSession = (id, session) => {
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session), 'utf8');
  };
  const makeChangeDir = (slug) => {
    const dir = path.join(planDir, 'changes', slug);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  writeSession(thisId, { id: thisId, phase: 'implement', openspecChange: 'this-change' });
  makeChangeDir('this-change');

  const openA = makeChangeDir('open-a');
  writeSession('other-open-a', { id: 'other-open-a', phase: 'implement', openspecChange: 'open-a' });

  const openB = makeChangeDir('open-b');
  writeSession('other-open-b', { id: 'other-open-b', phase: 'review', openspecChange: 'open-b' });

  makeChangeDir('done-change');
  writeSession('done-session', { id: 'done-session', phase: 'done', openspecChange: 'done-change' });

  makeChangeDir('skipped-change');
  writeSession('skipped-session', {
    id: 'skipped-session',
    phase: 'skipped',
    openspecChange: 'skipped-change',
  });

  // openspecChange resolves to a path, but nothing was ever created there.
  writeSession('no-dir-session', {
    id: 'no-dir-session',
    phase: 'implement',
    openspecChange: 'missing-change',
  });

  // Same directory shape Forge uses for a session — not readable JSON.
  const malformedDir = path.join(sessionsDir, 'malformed-session');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, 'session.json'), '{not json', 'utf8');

  return { sessionsDir, planDir, thisId, expectedOpenDirs: [openA, openB].slice().sort() };
}

/**
 * Two-session git project: this session's own change dir, another *open*
 * session's change dir, and a shared file outside either — all with committed
 * baseline content, so the pending edits below are *tracked* modifications,
 * not new/untracked files. That distinction is the actual F111 gap: the
 * pre-existing `foreignUntrackedChangePaths` backstop only ever looked at
 * untracked paths, so a tracked edit under a foreign open session's change
 * dir sailed straight through `git add -A`. Both `session.json`s are `phase:
 * "implement"` (open) and their change dirs exist on disk, so
 * `otherOpenChangeDirs` finds the overlap.
 */
function makeTwoSessionProject({ branch = 'feature-x' } = {}) {
  const cwd = tmp('forge-ckpt-two-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');

  const mineFile = path.join(cwd, 'specs', 'changes', 'phase-1', 'existing.md');
  const foreignFile = path.join(cwd, 'specs', 'changes', 'other-change', 'existing.md');
  fs.mkdirSync(path.dirname(mineFile), { recursive: true });
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# base\n', 'utf8');
  fs.writeFileSync(mineFile, '# mine baseline\n', 'utf8');
  fs.writeFileSync(foreignFile, '# foreign baseline\n', 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  if (branch !== 'main') git(cwd, 'checkout', '-q', '-b', branch);

  const now = new Date().toISOString();
  const sessionsDir = path.join(cwd, '.forge', 'sessions');
  const writeSession = (id, session) => {
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ createdAt: now, updatedAt: now, ...session }),
      'utf8',
    );
  };
  writeSession('s1', {
    id: 's1',
    slug: 'phase-1',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'phase-1',
    baseCommit: baseSha,
    branch,
  });
  writeSession('s2', {
    id: 's2',
    slug: 'other-change',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'other-change',
    baseCommit: baseSha,
    branch,
  });
  fs.writeFileSync(path.join(cwd, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  fs.writeFileSync(
    path.join(cwd, '.forge', 'config.json'),
    `${JSON.stringify({ git: { checkpoint: 'per-group' }, plan: { engine: 'specs', dir: 'specs' } })}\n`,
    'utf8',
  );

  // Pending work: session 1's own edit (mine), a *tracked* edit under session
  // 2's change dir (foreignPlan), and a shared source file neither session's
  // change dir claims.
  fs.appendFileSync(mineFile, 'mine edit\n');
  fs.appendFileSync(foreignFile, 'foreign edit\n');
  fs.appendFileSync(path.join(cwd, 'README.md'), 'shared edit\n');

  return {
    cwd,
    sessionDir: path.join(sessionsDir, 's1'),
    baseSha,
    mineRelPath: 'specs/changes/phase-1/existing.md',
    foreignRelPath: 'specs/changes/other-change/existing.md',
    foreignChangeDir: 'specs/changes/other-change',
    sharedRelPath: 'README.md',
  };
}

test('checkpoint refuses when another open session is present and a foreignPlan/shared entry is pending', () => {
  // F111 red: `foreignRelPath` is a *tracked* edit under session s2's open
  // change dir — the old untracked-only backstop never saw it, so this used
  // to sail through `git add -A` and commit under session s1's name.
  const { cwd, foreignRelPath, sharedRelPath } = makeTwoSessionProject();
  const headBefore = git(cwd, 'rev-parse', 'HEAD');

  const { status, out, stderr } = run(cwd, ['--session', 's1', '--group', 'g1']);

  assert.equal(status, 1, 'refuses instead of committing');
  const text = `${stderr}${out ? JSON.stringify(out) : ''}`;
  assert.ok(text.includes(foreignRelPath), 'names the foreignPlan path');
  assert.ok(text.includes('s2'), "tags the foreignPlan path with its owning session");
  assert.ok(text.includes(sharedRelPath), 'names the shared path');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), headBefore, 'refusal makes no commit — HEAD unchanged');
  assert.equal(
    git(cwd, 'status', '--porcelain').includes(foreignRelPath) ||
      git(cwd, 'status', '--porcelain', '--', foreignRelPath) !== '',
    true,
    'the foreign edit is left uncommitted',
  );
});

test('--path scopes staging to mine + the named path, excluding a shared file; --path into a foreign change dir refuses', () => {
  const { cwd, mineRelPath, foreignChangeDir, sharedRelPath, foreignRelPath } = makeTwoSessionProject();
  // A second file under session s1's own change dir, not itself named on
  // --path — it must still land, because the whole "mine" dir is staged once
  // any --path is given, not just the literal argument.
  const mineSecondRel = 'specs/changes/phase-1/second.md';
  fs.writeFileSync(path.join(cwd, mineSecondRel), 'second mine file\n', 'utf8');

  const { status, out } = run(cwd, ['--session', 's1', '--group', 'g1', '--path', mineRelPath]);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.equal(out.committed, true);
  const committed = git(cwd, 'show', '--name-only', '--format=', 'HEAD')
    .split('\n')
    .filter(Boolean);
  assert.ok(committed.includes(mineRelPath), 'the named mine file lands');
  assert.ok(committed.includes(mineSecondRel), "the session's own change dir is staged wholesale");
  assert.equal(committed.includes(sharedRelPath), false, 'a shared file outside the named path is never swept in');
  assert.equal(committed.includes(foreignRelPath), false, 'the foreign session\'s file is never swept in');

  const headAfterFirst = git(cwd, 'rev-parse', 'HEAD');
  const refused = run(cwd, ['--session', 's1', '--group', 'g2', '--path', foreignChangeDir]);
  assert.equal(refused.status, 1, '--path into a foreign open session\'s change dir refuses');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), headAfterFirst, 'refusal makes no commit');
});

test('--path matching nothing pending is a clean no-op, not a git commit failure (F134)', () => {
  // The session has no change of its own (mineDir empty) and the named --path
  // matches nothing pending, so the scoped staging set is empty. The old code
  // skipped `git add` and ran `git commit` against an empty index, surfacing
  // git's generic "nothing to commit" as a checkpoint failure.
  const cwd = tmp('forge-ckpt-empty-scope-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  const foreignFile = path.join(cwd, 'specs', 'changes', 'other-change', 'existing.md');
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(foreignFile, '# foreign baseline\n', 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '-q', '-b', 'feature-x');

  const now = new Date().toISOString();
  const sessionsDir = path.join(cwd, '.forge', 'sessions');
  const writeSession = (id, session) => {
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ createdAt: now, updatedAt: now, ...session }),
      'utf8',
    );
  };
  writeSession('s1', {
    id: 's1',
    slug: 'direct-work',
    phase: 'implement',
    planType: 'direct',
    baseCommit: baseSha,
    branch: 'feature-x',
  });
  writeSession('s2', {
    id: 's2',
    slug: 'other-change',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'other-change',
    baseCommit: baseSha,
    branch: 'feature-x',
  });
  fs.writeFileSync(path.join(cwd, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  fs.writeFileSync(
    path.join(cwd, '.forge', 'config.json'),
    `${JSON.stringify({ git: { checkpoint: 'per-group' }, plan: { engine: 'specs', dir: 'specs' } })}\n`,
    'utf8',
  );

  // The only pending change belongs to the other open session; the --path
  // scope names a path with nothing pending under it.
  fs.appendFileSync(foreignFile, 'foreign edit\n');

  const { status, out, stderr } = run(cwd, ['--session', 's1', '--group', 'g1', '--path', 'src']);
  assert.equal(status, 0, `empty scope must not fail: ${stderr}`);
  assert.equal(out.ok, true);
  assert.equal(out.committed, false);
  assert.match(out.reason, /nothing to checkpoint/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), baseSha, 'no empty commit is created');
  assert.ok(
    git(cwd, 'status', '--porcelain').includes('other-change'),
    'the foreign edit is left untouched',
  );
});

/**
 * Same two-session shape as `makeTwoSessionProject`, except session s2 is
 * open (its change dir exists on disk) but has *no* pending changes in it —
 * only this session's own change dir does, and nothing shared is pending
 * either. Spec scenario 4: "only this session's changes still checkpoints
 * cleanly" — the *proceed* branch of the gate, which before this test was
 * pinned only by the pure `classifyPendingEntries` unit test, never at the
 * CLI level.
 */
function makeTwoSessionProjectMineOnly({ branch = 'feature-x' } = {}) {
  const cwd = tmp('forge-ckpt-mineonly-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');

  const mineFile = path.join(cwd, 'specs', 'changes', 'phase-1', 'existing.md');
  const foreignFile = path.join(cwd, 'specs', 'changes', 'other-change', 'existing.md');
  fs.mkdirSync(path.dirname(mineFile), { recursive: true });
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# base\n', 'utf8');
  fs.writeFileSync(mineFile, '# mine baseline\n', 'utf8');
  fs.writeFileSync(foreignFile, '# foreign baseline\n', 'utf8');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  if (branch !== 'main') git(cwd, 'checkout', '-q', '-b', branch);

  const now = new Date().toISOString();
  const sessionsDir = path.join(cwd, '.forge', 'sessions');
  const writeSession = (id, session) => {
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ createdAt: now, updatedAt: now, ...session }),
      'utf8',
    );
  };
  writeSession('s1', {
    id: 's1',
    slug: 'phase-1',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'phase-1',
    baseCommit: baseSha,
    branch,
  });
  writeSession('s2', {
    id: 's2',
    slug: 'other-change',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'other-change',
    baseCommit: baseSha,
    branch,
  });
  fs.writeFileSync(path.join(cwd, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`, 'utf8');
  fs.writeFileSync(
    path.join(cwd, '.forge', 'config.json'),
    `${JSON.stringify({ git: { checkpoint: 'per-group' }, plan: { engine: 'specs', dir: 'specs' } })}\n`,
    'utf8',
  );

  // Only this session's own change dir has pending work: s2 is open (its
  // change dir exists) but untouched, and nothing shared is pending.
  fs.appendFileSync(mineFile, 'mine edit\n');

  return {
    cwd,
    sessionDir: path.join(sessionsDir, 's1'),
    baseSha,
    mineRelPath: 'specs/changes/phase-1/existing.md',
  };
}

test("only this session's own changes are pending while another session is open — checkpoint still proceeds and commits", () => {
  const { cwd, sessionDir, mineRelPath } = makeTwoSessionProjectMineOnly();
  const headBefore = git(cwd, 'rev-parse', 'HEAD');

  const { status, out } = run(cwd, ['--session', 's1', '--group', 'g1']);

  assert.equal(status, 0, 'proceeds — no refusal when only mine is pending');
  assert.equal(out.ok, true);
  assert.equal(out.committed, true);
  const headAfter = git(cwd, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter, headBefore, 'HEAD advances');
  assert.equal(headAfter, out.sha);
  const committed = git(cwd, 'show', '--name-only', '--format=', 'HEAD')
    .split('\n')
    .filter(Boolean);
  assert.ok(committed.includes(mineRelPath), 'the mine file lands in the commit');
  assert.equal(readSession(sessionDir).checkpoints.length, 1);
});

test('a single open session still stages git add -A and commits, and the foreign-untracked backstop still refuses', () => {
  // Regression guard for F111: with no other open session, the overlap gate
  // must not engage at all — same `git add -A` + `foreignUntrackedChangePaths`
  // path as before this change.
  const { cwd, sessionDir } = makeProject();
  const { status, out } = run(cwd, ['--group', 'group-01']);
  assert.equal(status, 0);
  assert.equal(out.committed, true);
  assert.deepEqual(out.files.sort(), ['README.md', 'new-module.mjs']);
  assert.equal(readSession(sessionDir).checkpoints.length, 1);

  // The existing untracked-only backstop (F72) still refuses on its own.
  const cwd2 = makeProject({
    config: { git: { checkpoint: 'per-group' }, plan: { engine: 'specs', dir: 'specs' } },
  }).cwd;
  const foreign = path.join(cwd2, 'specs', 'changes', 'other-change', 'proposal.md');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, '# other\n', 'utf8');
  const headBefore = git(cwd2, 'rev-parse', 'HEAD');
  const refused = run(cwd2, ['--group', 'group-01']);
  assert.equal(refused.status, 1);
  assert.equal(git(cwd2, 'rev-parse', 'HEAD'), headBefore);
});

test('otherOpenChangeDirs: skips done, skipped, this session, no-dir, and malformed sessions', () => {
  const { sessionsDir, planDir, thisId, expectedOpenDirs } = makeOtherSessionsFixture();

  const dirs = otherOpenChangeDirs(sessionsDir, thisId, planDir);

  assert.deepEqual(dirs.slice().sort(), expectedOpenDirs);
});

test('classifyPendingEntries: partitions mine / foreignPlan / shared, segment-aware', () => {
  const mineDir = '/plan/changes/mine';
  const foreignA = '/plan/changes/foreign-a';
  const foreignB = '/plan/changes/foreign-b';
  const otherDirs = [foreignA, foreignB];

  const mineNested = `${mineDir}/file.md`;
  const mineExact = mineDir;
  // Shares mine's characters but is a different path segment — `src/foo` must
  // not match `src/foobar`. A plain `startsWith(mineDir)` (no `/` boundary)
  // would wrongly land this in `mine`.
  const mineSiblingPrefix = '/plan/changes/mineextra/file.md';
  const foreignANested = `${foreignA}/file.md`;
  const foreignAExact = foreignA;
  const foreignASiblingPrefix = '/plan/changes/foreign-aextra/file.md';
  const foreignBDeep = `${foreignB}/nested/deep.md`;
  const unrelated = 'src/shared.mjs';

  const pending = [
    { path: mineNested },
    { path: mineExact },
    { path: mineSiblingPrefix },
    { path: foreignANested },
    { path: foreignAExact },
    { path: foreignASiblingPrefix },
    { path: foreignBDeep },
    { path: unrelated },
  ];

  const result = classifyPendingEntries(pending, mineDir, otherDirs);

  assert.deepEqual(result.mine.slice().sort(), [mineExact, mineNested].sort());
  assert.deepEqual(
    result.foreignPlan.slice().sort(),
    [foreignAExact, foreignANested, foreignBDeep].sort(),
  );
  assert.deepEqual(
    result.shared.slice().sort(),
    [mineSiblingPrefix, foreignASiblingPrefix, unrelated].sort(),
  );
});
