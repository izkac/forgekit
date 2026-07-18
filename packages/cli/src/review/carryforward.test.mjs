import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseArgs,
  locationFile,
  nextFindingId,
  buildCarriedFinding,
  recomputeSummary,
  planCarries,
  runCarryforward,
} from './carryforward.mjs';
import { validateReport } from './lib.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/**
 * Scratch repo with two commits: parent SHA has a.txt + b.txt; HEAD changes b.txt.
 *
 * @param {string} repoDir
 * @returns {{ parentSha: string, headSha: string }}
 */
function makeScratchRepo(repoDir) {
  git(repoDir, ['init', '-q']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'beta\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'first']);
  const parentSha = git(repoDir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'beta changed\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'second']);
  const headSha = git(repoDir, ['rev-parse', 'HEAD']);
  return { parentSha, headSha };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function makeParentReport(overrides = {}) {
  return {
    review_id: '20260101T000000Z-parent-scope',
    kind: 'review',
    created_at: '2026-01-01T00:00:00.000Z',
    scope: { type: 'branch', description: 'parent scope' },
    lenses: ['correctness'],
    summary: { tentative_count: 3, confirmed: 3 },
    findings: [
      {
        id: 'F-001',
        lens: 'correctness',
        location: 'a.txt:10',
        claim: 'unchanged file finding',
        evidence: 'snippet-a',
        severity: 'important',
        verdict: 'confirmed',
        verdict_reason: 'original reason A',
      },
      {
        id: 'F-002',
        lens: 'correctness',
        location: 'b.txt:5-8',
        claim: 'changed file finding',
        severity: 'minor',
        verdict: 'confirmed',
        verdict_reason: 'original reason B',
      },
      {
        id: 'F-003',
        lens: 'correctness',
        location: 'missing.txt:1',
        claim: 'file absent at parent sha',
        severity: 'minor',
        verdict: 'confirmed',
        verdict_reason: 'original reason C',
      },
    ],
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function makeTargetReport(overrides = {}) {
  return {
    review_id: '20260201T000000Z-target-scope',
    kind: 'review',
    created_at: '2026-02-01T00:00:00.000Z',
    scope: { type: 'branch', description: 'target scope' },
    lenses: ['correctness'],
    summary: { tentative_count: 1, confirmed: 1 },
    findings: [
      {
        id: 'F-001',
        lens: 'correctness',
        location: 'other.txt:1',
        claim: 'pre-existing target finding',
        severity: 'minor',
        verdict: 'confirmed',
        verdict_reason: 'target reason',
      },
    ],
    ...overrides,
  };
}

/**
 * @param {string} dir
 * @param {string} base
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
function writeReport(dir, base, report) {
  const p = path.join(dir, base);
  fs.writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs parses parent, file, dry-run, reviews-dir and repo', () => {
  const opts = parseArgs([
    '--parent', '20260101T000000Z-parent-scope',
    '--file', 'target.json',
    '--dry-run',
    '--reviews-dir', 'rdir',
    '--repo', 'repodir',
  ]);
  assert.equal(opts.parent, '20260101T000000Z-parent-scope');
  assert.equal(opts.file, 'target.json');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.reviewsDir, 'rdir');
  assert.equal(opts.repo, 'repodir');
});

test('parseArgs defaults and unknown-arg rejection', () => {
  const opts = parseArgs(['--parent', 'x']);
  assert.equal(opts.file, null);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.reviewsDir, '.reviews');
  assert.equal(opts.repo, null);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('locationFile strips :line and :start-end suffixes', () => {
  assert.equal(locationFile('a.ts:42'), 'a.ts');
  assert.equal(locationFile('src/lib/a.ts:10-20'), 'src/lib/a.ts');
  assert.equal(locationFile('src/lib/a.ts'), 'src/lib/a.ts');
});

test('nextFindingId continues F-### numbering, ignoring dup ids', () => {
  assert.equal(nextFindingId([]), 'F-001');
  assert.equal(
    nextFindingId([{ id: 'F-001' }, { id: 'F-003' }, { id: 'dup-009' }]),
    'F-004',
  );
});

test('buildCarriedFinding preserves fields and prefixes verdict_reason', () => {
  const parentFinding = {
    id: 'F-007',
    lens: 'security',
    location: 'a.ts:1',
    claim: 'claim text',
    evidence: 'evidence text',
    severity: 'important',
    verdict: 'confirmed',
    verdict_reason: 'original reason',
  };
  const carried = buildCarriedFinding(parentFinding, {
    id: 'F-004',
    parentReviewId: '20260101T000000Z-parent-scope',
    shortSha: 'abcdef12',
  });
  assert.equal(carried.id, 'F-004');
  assert.equal(carried.lens, 'security');
  assert.equal(carried.location, 'a.ts:1');
  assert.equal(carried.claim, 'claim text');
  assert.equal(carried.evidence, 'evidence text');
  assert.equal(carried.severity, 'important');
  assert.equal(carried.verdict, 'confirmed');
  assert.equal(
    carried.verdict_reason,
    'Carried forward from 20260101T000000Z-parent-scope (unchanged since abcdef12): original reason',
  );
});

test('buildCarriedFinding keeps original_severity for downgraded findings', () => {
  const carried = buildCarriedFinding(
    {
      id: 'F-001',
      lens: 'correctness',
      location: 'a.ts:1',
      claim: 'c',
      severity: 'minor',
      original_severity: 'important',
      verdict: 'downgraded',
      verdict_reason: 'r',
    },
    { id: 'F-002', parentReviewId: 'p', shortSha: '12345678' },
  );
  assert.equal(carried.original_severity, 'important');
  assert.equal(carried.verdict, 'downgraded');
});

test('recomputeSummary reconciles verdict counts and tentative_count', () => {
  const report = makeTargetReport({
    summary: { tentative_count: 1, confirmed: 1, headline: 'keep me' },
    findings: [
      ...makeTargetReport().findings,
      {
        id: 'F-002',
        lens: 'correctness',
        location: 'a.txt:10',
        claim: 'carried',
        severity: 'important',
        verdict: 'confirmed',
        verdict_reason: 'r',
      },
      {
        id: 'F-003',
        lens: 'correctness',
        location: 'a.txt:11',
        claim: 'fp',
        severity: 'minor',
        verdict: 'false_positive',
        verdict_reason: 'r',
      },
    ],
  });
  recomputeSummary(report);
  assert.equal(report.summary.confirmed, 2);
  assert.equal(report.summary.false_positive, 1);
  assert.equal(report.summary.headline, 'keep me');
  assert.ok(report.summary.tentative_count >= 3);
  assert.equal(validateReport(report).ok, true);
});

// ---------------------------------------------------------------------------
// planCarries — decision core with injected git ops
// ---------------------------------------------------------------------------

test('planCarries carries unchanged, skips changed/missing/errored', () => {
  const parent = makeParentReport({ scope: { type: 'branch', description: 'p', head_sha: 'a'.repeat(40) } });
  const target = makeTargetReport();
  const gitOps = {
    fileChanged: (sha, file) => {
      if (file === 'missing.txt') throw new Error('git boom');
      return file === 'b.txt';
    },
    fileExistsAt: (sha, file) => file !== 'missing.txt',
  };
  const plan = planCarries(parent, target, gitOps);
  assert.equal(plan.carries.length, 1);
  assert.equal(plan.carries[0].finding.id, 'F-002'); // continues target numbering
  assert.equal(plan.carries[0].parentId, 'F-001');
  assert.equal(plan.skips.length, 2);
  assert.ok(plan.skips.some((s) => s.parentId === 'F-002' && /changed/.test(s.reason)));
  assert.ok(plan.skips.some((s) => s.parentId === 'F-003' && /git boom|git error/.test(s.reason)));
});

test('planCarries skips everything when parent has no head_sha', () => {
  const parent = makeParentReport(); // no scope.head_sha
  const target = makeTargetReport();
  const plan = planCarries(parent, target, {
    fileChanged: () => false,
    fileExistsAt: () => true,
  });
  assert.equal(plan.carries.length, 0);
  assert.equal(plan.skips.length, 3);
  assert.ok(plan.skips.every((s) => /head_sha/.test(s.reason)));
});

test('planCarries skips findings already present in the target', () => {
  const parent = makeParentReport({ scope: { type: 'branch', description: 'p', head_sha: 'b'.repeat(40) } });
  const target = makeTargetReport({
    findings: [
      {
        id: 'F-001',
        lens: 'correctness',
        location: 'a.txt:10',
        claim: 'unchanged file finding',
        severity: 'important',
        verdict: 'confirmed',
        verdict_reason: 'already here',
      },
    ],
  });
  const plan = planCarries(parent, target, {
    fileChanged: () => false,
    fileExistsAt: () => true,
  });
  assert.equal(plan.carries.length, 2); // F-002 + F-003 (git says unchanged/exists)
  assert.ok(plan.skips.some((s) => s.parentId === 'F-001' && /already present/.test(s.reason)));
});

// ---------------------------------------------------------------------------
// runCarryforward — end-to-end against a scratch git repo
// ---------------------------------------------------------------------------

test('runCarryforward carries unchanged findings into the target report', () => {
  const dir = tmp('review-carry-');
  try {
    const { parentSha } = makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    const parent = makeParentReport({
      scope: { type: 'branch', description: 'p', head_sha: parentSha },
    });
    writeReport(reviewsDir, '20260101T000000Z-parent-scope-review.json', parent);
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );

    const result = runCarryforward({
      parent: '20260101T000000Z-parent-scope',
      file: targetPath,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(result.message.includes('1 carried'));
    assert.ok(result.message.includes('2 skipped'));

    const updated = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(updated.findings.length, 2);
    const carried = updated.findings[1];
    assert.equal(carried.id, 'F-002');
    assert.equal(carried.location, 'a.txt:10');
    assert.equal(
      carried.verdict_reason,
      `Carried forward from 20260101T000000Z-parent-scope (unchanged since ${parentSha.slice(0, 8)}): original reason A`,
    );
    assert.equal(updated.summary.confirmed, 2);
    assert.equal(validateReport(updated).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward blocks a carry when the file has uncommitted edits', () => {
  const dir = tmp('review-carry-wt-');
  try {
    const { parentSha } = makeScratchRepo(dir);
    // a.txt is unchanged in git history but edited in the working tree
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha edited locally\n');
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    const parent = makeParentReport({
      scope: { type: 'branch', description: 'p', head_sha: parentSha },
    });
    writeReport(reviewsDir, '20260101T000000Z-parent-scope-review.json', parent);
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );

    const result = runCarryforward({
      parent: '20260101T000000Z-parent-scope',
      file: targetPath,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(result.message.includes('0 carried'));

    const updated = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(updated.findings.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward --dry-run prints the plan but writes nothing', () => {
  const dir = tmp('review-carry-dry-');
  try {
    const { parentSha } = makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    const parent = makeParentReport({
      scope: { type: 'branch', description: 'p', head_sha: parentSha },
    });
    const parentPath = writeReport(
      reviewsDir,
      '20260101T000000Z-parent-scope-review.json',
      parent,
    );
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );
    const before = fs.readFileSync(targetPath, 'utf8');

    const result = runCarryforward({
      parent: parentPath,
      file: targetPath,
      dryRun: true,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(result.message.includes('dry-run'));
    assert.ok(result.message.includes('CARRY'));
    assert.ok(result.message.includes('SKIP'));
    assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward defaults --file to newest non-parent non-reverify report', () => {
  const dir = tmp('review-carry-default-');
  try {
    const { parentSha } = makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    const parent = makeParentReport({
      scope: { type: 'branch', description: 'p', head_sha: parentSha },
    });
    writeReport(reviewsDir, '20260101T000000Z-parent-scope-review.json', parent);
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );
    // Newest by mtime, but kind=reverify → must be passed over.
    const reverifyPath = writeReport(
      reviewsDir,
      '20260301T000000Z-later-scope-review.json',
      makeTargetReport({
        review_id: '20260301T000000Z-later-scope',
        kind: 'reverify',
        parent_report: '20260201T000000Z-target-scope',
        findings: [],
        summary: { tentative_count: 0 },
      }),
    );
    const now = Date.now();
    fs.utimesSync(targetPath, (now - 10_000) / 1000, (now - 10_000) / 1000);
    fs.utimesSync(reverifyPath, now / 1000, now / 1000);

    const result = runCarryforward({
      parent: '20260101T000000Z-parent-scope',
      file: null,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 0, result.message);
    const updated = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(updated.findings.length, 2);
    const untouched = JSON.parse(fs.readFileSync(reverifyPath, 'utf8'));
    assert.equal(untouched.findings.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward skips all and writes nothing when parent lacks head_sha', () => {
  const dir = tmp('review-carry-nosha-');
  try {
    makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    writeReport(reviewsDir, '20260101T000000Z-parent-scope-review.json', makeParentReport());
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );
    const before = fs.readFileSync(targetPath, 'utf8');

    const result = runCarryforward({
      parent: '20260101T000000Z-parent-scope',
      file: targetPath,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(result.message.includes('0 carried'));
    assert.ok(result.message.includes('3 skipped'));
    assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward errors on missing parent and refuses invalid results', () => {
  const dir = tmp('review-carry-err-');
  try {
    makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);

    const missing = runCarryforward({
      parent: 'no-such-id',
      file: null,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(missing.exitCode, 1);
    assert.ok(missing.message.includes('no-such-id'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCarryforward refuses to write a target that fails validation', () => {
  const dir = tmp('review-carry-invalid-');
  try {
    const { parentSha } = makeScratchRepo(dir);
    const reviewsDir = path.join(dir, 'reviews');
    fs.mkdirSync(reviewsDir);
    // Parent carries a reverify verdict — invalid inside a kind=review target.
    const parent = makeParentReport({
      kind: 'reverify',
      parent_report: 'some-earlier-review',
      scope: { type: 'branch', description: 'p', head_sha: parentSha },
      summary: { tentative_count: 1, still_open: 1 },
      findings: [
        {
          id: 'F-001',
          lens: 'correctness',
          location: 'a.txt:10',
          claim: 'still broken',
          severity: 'important',
          verdict: 'still_open',
          verdict_reason: 'r',
        },
      ],
    });
    writeReport(reviewsDir, '20260101T000000Z-parent-scope-review.json', parent);
    const targetPath = writeReport(
      reviewsDir,
      '20260201T000000Z-target-scope-review.json',
      makeTargetReport(),
    );
    const before = fs.readFileSync(targetPath, 'utf8');

    const result = runCarryforward({
      parent: '20260101T000000Z-parent-scope',
      file: targetPath,
      dryRun: false,
      reviewsDir,
      repo: dir,
    });
    assert.equal(result.exitCode, 1);
    assert.ok(/validation/i.test(result.message));
    assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
