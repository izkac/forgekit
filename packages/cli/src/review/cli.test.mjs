import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { countChangedLines, parseArgs as parseNewArgs, runNew } from './new-review.mjs';
import { parseArgs as parseRenderArgs, runRender } from './render.mjs';
import { validateReport } from './lib.mjs';

const FIXED_NOW = new Date('2026-06-05T16:00:00.000Z');
const stubGit = () => ({ baseSha: 'base000', headSha: 'head111' });

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

// --- new-review ---

test('runNew scaffolds a schema-valid skeleton with git SHAs', () => {
  const dir = tmp('tmp-new-');
  try {
    const opts = parseNewArgs(['mercury-vat', '--type', 'branch']);
    const result = runNew(opts, { now: FIXED_NOW, cwd: dir, gitImpl: stubGit });
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(result.jsonPath.endsWith('20260605T160000Z-mercury-vat-review.json'));
    const report = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
    assert.equal(report.review_id, '20260605T160000Z-mercury-vat');
    assert.equal(report.scope.base_sha, 'base000');
    assert.equal(report.scope.head_sha, 'head111');
    // Default is the four defect lenses, not all nine — the other five yield
     // mostly minors, which is where review cost went.
    assert.deepEqual(report.lenses, ['security', 'correctness', 'errors', 'contracts']);
    assert.equal(report.preset, 'standard', 'stub git cannot measure lines → fail closed');
    assert.equal(validateReport(report).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runNew refuses to overwrite an existing report', () => {
  const dir = tmp('tmp-new-');
  try {
    const opts = parseNewArgs(['dup-scope', '--no-git']);
    assert.equal(runNew(opts, { now: FIXED_NOW, cwd: dir }).exitCode, 0);
    const second = runNew(opts, { now: FIXED_NOW, cwd: dir });
    assert.equal(second.exitCode, 1);
    assert.ok(second.message.includes('refusing to overwrite'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runNew rejects reverify without --parent', () => {
  const dir = tmp('tmp-new-');
  try {
    const opts = parseNewArgs(['x', '--kind', 'reverify', '--no-git']);
    const result = runNew(opts, { now: FIXED_NOW, cwd: dir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.message.includes('reverify'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new-review parseArgs splits comma lists and flags', () => {
  const opts = parseNewArgs(['scope', '--lenses', 'security,correctness', '--paths', 'a.ts,b.ts', '--no-git']);
  assert.deepEqual(opts.lenses, ['security', 'correctness']);
  assert.deepEqual(opts.paths, ['a.ts', 'b.ts']);
  assert.equal(opts.git, false);
});

// --- render ---

test('runRender writes paired .md from JSON', () => {
  const dir = tmp('tmp-render-');
  try {
    const report = {
      review_id: '20260605T160000Z-x',
      kind: 'review',
      created_at: '2026-06-05T16:00:00.000Z',
      scope: { type: 'file', description: 'x.ts' },
      lenses: ['security'],
      summary: { tentative_count: 1, confirmed: 1, headline: 'one confirmed' },
      findings: [
        {
          id: 'F-001',
          lens: 'security',
          location: 'x.ts:1',
          claim: 'auth bypass',
          severity: 'critical',
          verdict: 'confirmed',
          verdict_reason: 'real',
        },
      ],
    };
    const jsonPath = path.join(dir, '20260605T160000Z-x-review.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report));
    const opts = parseRenderArgs(['--file', jsonPath]);
    const result = runRender(opts, dir);
    assert.equal(result.exitCode, 0, result.message);
    const md = fs.readFileSync(jsonPath.replace(/\.json$/, '.md'), 'utf8');
    assert.ok(md.includes('## Critical'));
    assert.ok(md.includes('one confirmed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runRender fails on an invalid report', () => {
  const dir = tmp('tmp-render-');
  try {
    const jsonPath = path.join(dir, '20260605T160000Z-bad-review.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ kind: 'review' }));
    const result = runRender(parseRenderArgs(['--file', jsonPath]), dir);
    assert.equal(result.exitCode, 1);
    assert.ok(result.message.includes('validation failed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- presets ---

test('preset auto resolves from diff size, and the caps are printed for the orchestrator', () => {
  const dir = tmp('tmp-preset-');
  try {
    const small = runNew(parseNewArgs(['small-change']), {
      now: FIXED_NOW,
      cwd: dir,
      gitImpl: stubGit,
      linesImpl: () => 120,
    });
    assert.equal(small.preset, 'quick', small.message);
    assert.match(small.message, /preset:    quick \(120 changed line\(s\) <= 300\)/);
    // The policy is printed because prose-only caps were not being honored.
    assert.match(small.message, /scouts:          1/);
    assert.match(small.message, /skeptic budget:  3/);
    assert.match(small.message, /verify from:     critical/);
    assert.match(small.message, /second opinions: 0/);

    const big = runNew(parseNewArgs(['big-change']), {
      now: new Date('2026-06-05T17:00:00.000Z'),
      cwd: dir,
      gitImpl: stubGit,
      linesImpl: () => 900,
    });
    assert.equal(big.preset, 'standard', big.message);
    assert.match(big.message, /skeptic budget:  6/);
    assert.match(big.message, /verify from:     important/);

    // Unmeasurable scope fails closed to standard, never to quick.
    const blind = runNew(parseNewArgs(['blind-change']), {
      now: new Date('2026-06-05T18:00:00.000Z'),
      cwd: dir,
      gitImpl: stubGit,
      linesImpl: () => null,
    });
    assert.equal(blind.preset, 'standard');
    assert.match(blind.message, /unmeasurable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deep is never automatic; --preset deep and --all-lenses open all nine lenses', () => {
  const dir = tmp('tmp-preset-deep-');
  try {
    // A huge diff still resolves to standard — deep is a deliberate purchase.
    const auto = runNew(parseNewArgs(['huge']), {
      now: FIXED_NOW,
      cwd: dir,
      gitImpl: stubGit,
      linesImpl: () => 50000,
    });
    assert.equal(auto.preset, 'standard');

    const deep = runNew(parseNewArgs(['audit', '--preset', 'deep']), {
      now: new Date('2026-06-05T17:00:00.000Z'),
      cwd: dir,
      gitImpl: stubGit,
    });
    assert.equal(deep.preset, 'deep');
    const deepReport = JSON.parse(fs.readFileSync(deep.jsonPath, 'utf8'));
    assert.equal(deepReport.lenses.length, 9);
    assert.equal(deepReport.preset, 'deep');
    assert.match(deep.message, /verify from:     minor/);

    const all = runNew(parseNewArgs(['wide', '--all-lenses']), {
      now: new Date('2026-06-05T18:00:00.000Z'),
      cwd: dir,
      gitImpl: stubGit,
      linesImpl: () => 10,
    });
    const allReport = JSON.parse(fs.readFileSync(all.jsonPath, 'utf8'));
    assert.equal(allReport.lenses.length, 9, 'all-lenses widens lenses');
    assert.equal(allReport.preset, 'quick', 'without changing the dispatch budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit --lenses wins over the preset, and an unknown preset is refused', () => {
  const dir = tmp('tmp-preset-lenses-');
  try {
    const narrowed = runNew(parseNewArgs(['narrow', '--preset', 'deep', '--lenses', 'security']), {
      now: FIXED_NOW,
      cwd: dir,
      gitImpl: stubGit,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(narrowed.jsonPath, 'utf8')).lenses, ['security']);

    const bogus = runNew(parseNewArgs(['bogus', '--preset', 'thorough']), {
      now: FIXED_NOW,
      cwd: dir,
      gitImpl: stubGit,
    });
    assert.equal(bogus.exitCode, 1);
    assert.match(bogus.message, /unknown preset: thorough/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countChangedLines sums added + deleted and ignores binary rows', () => {
  // git reports '-\t-\tfile' for binaries; counting them as 0 keeps a
  // lockfile-and-image commit from forcing the expensive preset.
  const dir = tmp('tmp-lines-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
    execFileSync('git', ['add', '.'], { cwd: dir });

    assert.equal(countChangedLines(dir, 'uncommitted', 'main'), 1);
    // Scope types git cannot diff report null rather than a wrong number.
    assert.equal(countChangedLines(dir, 'paths', 'main'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
