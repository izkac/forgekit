import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs as parseNewArgs, runNew } from './new-review.mjs';
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
    assert.equal(report.lenses.length, 9);
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
