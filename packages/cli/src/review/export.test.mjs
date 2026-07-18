import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  validateReport,
  findLatestReviewJson,
  countOpenCritical,
  formatSummary,
} from './lib.mjs';
import { parseArgs, runExport } from './export.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'valid-review.json');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}
const validFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('validateReport accepts valid fixture', () => {
  const result = validateReport(validFixture);
  assert.equal(result.ok, true);
});

test('validateReport rejects missing review_id', () => {
  const bad = { ...validFixture };
  delete bad.review_id;
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('review_id')));
});

test('validateReport rejects reverify without parent_report', () => {
  const bad = {
    ...validFixture,
    kind: 'reverify',
    findings: [
      {
        ...validFixture.findings[0],
        verdict: 'still_open',
      },
    ],
  };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('parent_report')));
});

test('countOpenCritical counts confirmed critical only', () => {
  const withCritical = {
    ...validFixture,
    findings: [
      {
        id: 'F-001',
        lens: 'security',
        location: 'a.ts:1',
        claim: 'x',
        severity: 'critical',
        verdict: 'confirmed',
        verdict_reason: 'real',
      },
    ],
  };
  assert.equal(countOpenCritical(withCritical), 1);
  assert.equal(countOpenCritical(validFixture), 0);
});

test('parseArgs handles --fail-on critical', () => {
  const opts = parseArgs(['--file', 'x.json', '--fail-on', 'critical']);
  assert.equal(opts.failOnCritical, true);
  assert.equal(opts.file, 'x.json');
});

test('runExport succeeds on fixture', () => {
  const result = runExport({ file: fixturePath, out: null, failOnCritical: false });
  assert.equal(result.exitCode, 0);
  assert.ok(result.message.includes('OK'));
  assert.ok(result.message.includes('review_id'));
});

test('runExport --fail-on critical fails when critical confirmed', () => {
  const tmpDir = tmp('review-export-');
  try {
    const criticalReport = {
      ...validFixture,
      summary: { tentative_count: 1, confirmed: 1 },
      findings: [
        {
          id: 'F-001',
          lens: 'security',
          location: 'a.ts:1',
          claim: 'auth bypass',
          severity: 'critical',
          verdict: 'confirmed',
          verdict_reason: 'missing check',
        },
      ],
    };
    const jsonPath = path.join(tmpDir, '20260605-smoke-review.json');
    fs.writeFileSync(jsonPath, JSON.stringify(criticalReport));

    const result = runExport(
      { file: jsonPath, out: null, failOnCritical: true, reviewsDir: '.reviews' },
      tmpDir,
    );
    assert.equal(result.exitCode, 1);
    assert.ok(result.message.includes('open critical'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseArgs accepts --fail-on important and --render-md', () => {
  const opts = parseArgs(['--fail-on', 'important', '--render-md']);
  assert.equal(opts.failOn, 'important');
  assert.equal(opts.failOnCritical, false);
  assert.equal(opts.renderMd, true);
});

test('parseArgs rejects an unsupported --fail-on level', () => {
  assert.throws(() => parseArgs(['--fail-on', 'nope']), /unsupported --fail-on/);
});

test('runExport --fail-on important catches an open important finding', () => {
  const tmpDir = tmp('review-important-');
  try {
    const report = {
      ...validFixture,
      summary: { tentative_count: 1, confirmed: 1 },
      findings: [
        {
          id: 'F-001',
          lens: 'correctness',
          location: 'a.ts:1',
          claim: 'edge case',
          severity: 'important',
          verdict: 'confirmed',
          verdict_reason: 'no guard',
        },
      ],
    };
    const jsonPath = path.join(tmpDir, '20260605-imp-review.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report));

    // critical gate passes (no critical), important gate fails
    assert.equal(runExport({ file: jsonPath, failOn: 'critical' }, tmpDir).exitCode, 0);
    const imp = runExport({ file: jsonPath, failOn: 'important' }, tmpDir);
    assert.equal(imp.exitCode, 1);
    assert.ok(imp.message.includes('open important+'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runExport --render-md regenerates the paired markdown', () => {
  const tmpDir = tmp('review-rendermd-');
  try {
    const jsonPath = path.join(tmpDir, '20260605-r-review.json');
    fs.writeFileSync(jsonPath, JSON.stringify(validFixture));
    const result = runExport({ file: jsonPath, renderMd: true }, tmpDir);
    assert.equal(result.exitCode, 0, result.message);
    assert.ok(fs.existsSync(jsonPath.replace(/\.json$/, '.md')));
    assert.ok(result.message.includes('rendered:'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findLatestReviewJson picks newest non-reverify file', () => {
  const tmpDir = tmp('review-find-');
  try {
    const older = path.join(tmpDir, '20260101-old-review.json');
    const newer = path.join(tmpDir, '20260201-new-review.json');
    const reverify = path.join(tmpDir, '20260202-scope-reverify.json');
    fs.writeFileSync(older, '{}');
    fs.writeFileSync(newer, '{}');
    fs.writeFileSync(reverify, '{}');

    const olderTime = Date.now() - 10_000;
    const newerTime = Date.now();
    fs.utimesSync(older, olderTime / 1000, olderTime / 1000);
    fs.utimesSync(newer, newerTime / 1000, newerTime / 1000);

    assert.equal(findLatestReviewJson(tmpDir), newer);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatSummary includes scope and counts', () => {
  const text = formatSummary(validFixture);
  assert.ok(text.includes('checkout-sessions'));
  assert.ok(text.includes('confirmed: 1'));
});
