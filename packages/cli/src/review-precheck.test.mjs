import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectPrecheck, renderPrecheck } from './review-precheck.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-precheck-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A git repo with one session: two tasks, one group review, one allowance. */
function makeProject({ groupReview, selfCheck = false } = {}) {
  const dir = tmp('forge-precheck-');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const baseCommit = git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');

  const sessionId = '20260904T000000Z-precheck-abc123';
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  const session = {
    id: sessionId,
    slug: 'precheck',
    phase: 'review',
    resolvedPace: 'standard',
    resolvedCeremony: 'full',
    baseCommit,
    features: { tddEvidence: true },
  };
  fs.mkdirSync(path.join(sessionDir, 'tasks', '1.1'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'tasks', '1.2'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), JSON.stringify({ sessionId }));
  const stamp = (expect, ok, exit, at) =>
    JSON.stringify({ expect, ok, exit, startedAt: at, cmd: 'node', args: ['--test', 'x.test.mjs'] });
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '1.1', 'tdd-runs.jsonl'),
    `${stamp('fail', true, 1, '2026-09-04T00:00:01Z')}\n${stamp('pass', true, 0, '2026-09-04T00:00:02Z')}\n`,
  );
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '1.2', 'test-evidence.md'),
    '<!-- forge:no-tdd-declared -->\n- **No-TDD reason:** docs only\n',
  );
  fs.writeFileSync(
    path.join(sessionDir, 'guard-allowances.json'),
    JSON.stringify([{ path: 'x.test.mjs', reason: 'adds a case', at: 'now', phase: 'implement' }]),
  );
  fs.writeFileSync(
    path.join(sessionDir, 'spine.json'),
    JSON.stringify({ version: 1, rows: [], notApplicable: 'test fixture' }),
  );
  if (groupReview) {
    const g = path.join(sessionDir, 'tasks', 'group-01-a');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(
      path.join(g, 'group-review.md'),
      selfCheck
        ? 'Reviewer: coordinator — APPROVED (pace self-check)\n'
        : 'Reviewer: sonnet (task-reviewer)\n\nVerdict: APPROVED. Fine.\n',
    );
  }
  return { dir, sessionDir, session, baseCommit };
}

test('precheck reports verified task evidence, allowances, changed files, and integration mode', () => {
  const { dir, sessionDir, session } = makeProject({ groupReview: true });
  const p = collectPrecheck({ cwd: dir, sessionDir, session });

  assert.equal(p.integrity.ok, true, JSON.stringify(p.integrity));
  assert.deepEqual(
    p.tasks.map((t) => [t.task, t.evidence, t.ok]),
    [['1.1', 'tdd', true], ['1.2', 'no-tdd', true]],
  );
  assert.match(p.tasks[0].detail, /node --test x\.test\.mjs/);
  assert.match(p.tasks[1].detail, /docs only/);
  assert.equal(p.allowances[0].reason, 'adds a case');
  assert.deepEqual(p.changed.tracked, ['M a.txt']);
  assert.deepEqual(p.changed.untracked, ['new.txt'], 'session scratch under .forge is excluded');
  assert.equal(p.reviews.length, 1);
  assert.equal(p.reviews[0].independent, true);
  assert.deepEqual(p.finalReview, { mode: 'integration', tier: 'standard', rejected: [] });

  const md = renderPrecheck(p);
  assert.match(md, /do not re-run/i);
  assert.match(md, /1\.1: ok — red→green verified/);
  assert.match(md, /x\.test\.mjs \(implement\): adds a case/);
  assert.match(md, /Final review mode: \*\*integration\*\*/);
});

test('precheck: no dispatched reviews (or self-checks only) → full-diff mode at capable', () => {
  const none = makeProject();
  assert.deepEqual(
    collectPrecheck({ cwd: none.dir, sessionDir: none.sessionDir, session: none.session }).finalReview,
    { mode: 'full-diff', tier: 'capable', rejected: [] },
  );
  const self = makeProject({ groupReview: true, selfCheck: true });
  const p = collectPrecheck({ cwd: self.dir, sessionDir: self.sessionDir, session: self.session });
  assert.equal(p.reviews[0].independent, false);
  assert.equal(p.finalReview.mode, 'full-diff');
});

test('precheck: one independent review beside self-checks is still integration; REJECTED units are named', () => {
  // Default pace writes coordinator self-checks for docs-only groups and
  // mid-group tasks — they must not push the final review back to full-diff.
  const { dir, sessionDir, session } = makeProject({ groupReview: true });
  const g2 = path.join(sessionDir, 'tasks', 'group-02-docs');
  fs.mkdirSync(g2, { recursive: true });
  fs.writeFileSync(path.join(g2, 'group-review.md'), 'Reviewer: coordinator — APPROVED (pace self-check)\n');
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', 'group-01-a', 'group-review.md'),
    'Reviewer: sonnet (task-reviewer)\n\n**Verdict: REJECTED** — allowance record inaccurate.\n',
  );
  // A file with no attribution at all is nobody's review.
  fs.mkdirSync(path.join(sessionDir, 'tasks', '1.1'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'tasks', '1.1', 'task-review.md'), 'Looks fine. APPROVED\n');

  const p = collectPrecheck({ cwd: dir, sessionDir, session, quick: true });
  assert.deepEqual(p.reviews.map((r) => [r.unit, r.independent, r.rejected]).sort(), [
    ['1.1', false, false],
    ['group-01-a', true, true],
    ['group-02-docs', false, false],
  ]);
  assert.deepEqual(p.finalReview, { mode: 'integration', tier: 'standard', rejected: ['group-01-a'] });
  assert.equal(p.tasks.length, 0, 'quick mode reads no ledgers');
  assert.equal(p.changed, null, 'quick mode runs no git');
  assert.match(renderPrecheck(p), /Re-read in full \(REJECTED on record\): group-01-a/);
});

test('precheck: a risky slug is high-risk even without a readable change dir', () => {
  const { dir, sessionDir, session } = makeProject({ groupReview: true });
  const risky = { ...session, slug: 'rotate-webhook-secret' };
  assert.deepEqual(collectPrecheck({ cwd: dir, sessionDir, session: risky, quick: true }).finalReview, {
    mode: 'integration',
    tier: 'capable',
    rejected: [],
  });
});

test('precheck: an unpaired ledger is a FAIL row; the CLI exits 1 on integrity problems only past implement', () => {
  const { dir, sessionDir, session } = makeProject({ groupReview: true });
  fs.writeFileSync(
    path.join(sessionDir, 'tasks', '1.1', 'tdd-runs.jsonl'),
    `${JSON.stringify({ expect: 'pass', ok: true, exit: 0, startedAt: '2026-09-04T00:00:02Z', cmd: 'node', args: ['--test'] })}\n`,
  );
  const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Integrity: PROBLEMS/);
  assert.match(r.stdout, /1\.1: FAIL — red→green NOT paired/);

  const j = spawnSync(process.execPath, [CLI, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(JSON.parse(j.stdout).tasks[0].ok, false);

  // Mid-implement the same problems print but do not block a group reviewer.
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ ...session, phase: 'implement' }));
  const impl = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
  assert.equal(impl.status, 0, impl.stderr);
  assert.match(impl.stdout, /Integrity: PROBLEMS/);
});
