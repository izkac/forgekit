import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReport,
  renderMarkdown,
  buildReviewSkeleton,
  compactStamp,
  slugify,
  countOpenAtOrAbove,
  countByVerdict,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-review.json'), 'utf8'),
);

// --- stamping / slug ---

test('compactStamp produces a compact UTC review stamp', () => {
  assert.equal(compactStamp(new Date('2026-06-05T16:00:00.000Z')), '20260605T160000Z');
});

test('slugify normalizes free text', () => {
  assert.equal(slugify('Mercury VAT / checkout!'), 'mercury-vat-checkout');
  assert.equal(slugify('   '), 'review');
});

// --- buildReviewSkeleton ---

test('buildReviewSkeleton yields a schema-valid review', () => {
  const { reviewId, fileBase, report } = buildReviewSkeleton({
    slug: 'mercury-vat',
    type: 'branch',
    now: new Date('2026-06-05T16:00:00.000Z'),
    headSha: 'abc123',
  });
  assert.equal(reviewId, '20260605T160000Z-mercury-vat');
  assert.equal(fileBase, '20260605T160000Z-mercury-vat-review');
  assert.equal(report.scope.head_sha, 'abc123');
  const result = validateReport(report);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('buildReviewSkeleton requires parent for reverify', () => {
  assert.throws(
    () => buildReviewSkeleton({ slug: 'x', kind: 'reverify', now: new Date('2026-06-05T16:00:00.000Z') }),
    /reverify/,
  );
});

test('buildReviewSkeleton reverify with parent is valid', () => {
  const { fileBase, report } = buildReviewSkeleton({
    slug: 'x',
    kind: 'reverify',
    parentReport: '20260101T000000Z-x',
    now: new Date('2026-06-05T16:00:00.000Z'),
  });
  assert.ok(fileBase.endsWith('-reverify'));
  assert.equal(report.parent_report, '20260101T000000Z-x');
});

// --- hardened validation ---

test('rejects non-ISO created_at', () => {
  const bad = { ...validFixture, created_at: 'June 5 2026' };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('created_at')));
});

test('rejects summary counts that disagree with findings', () => {
  const bad = { ...validFixture, summary: { ...validFixture.summary, confirmed: 5 } };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('summary.confirmed')));
});

test('rejects tentative_count below findings count', () => {
  const bad = { ...validFixture, summary: { ...validFixture.summary, tentative_count: 1 } };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('tentative_count')));
});

test('rejects downgraded finding without original_severity', () => {
  const bad = {
    ...validFixture,
    summary: { tentative_count: 1, downgraded: 1 },
    findings: [
      {
        id: 'F-001',
        lens: 'security',
        location: 'a.ts:1',
        claim: 'x',
        severity: 'minor',
        verdict: 'downgraded',
        verdict_reason: 'lowered',
      },
    ],
  };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('original_severity')));
});

test('accepts a finding with a valid second_opinion', () => {
  const ok = {
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
        verdict_reason: 'real',
        second_opinion: { verdict: 'confirmed', verdict_reason: 'second skeptic agrees', agrees: true },
      },
    ],
  };
  const result = validateReport(ok);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('rejects a malformed coverage ledger', () => {
  const bad = {
    ...validFixture,
    coverage: { lenses_without_findings: [{ lens: 'not-a-lens', reason: 'x' }] },
  };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('lenses_without_findings')));
});

test('accepts a report with valid stats', () => {
  const ok = {
    ...validFixture,
    stats: {
      scouts: 3,
      skeptics_dedicated: 2,
      skeptics_batched: 4,
      grounded_skips: 1,
      carried_forward: 0,
      second_opinions: 1,
    },
  };
  const result = validateReport(ok);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('report without stats is still valid', () => {
  const result = validateReport(validFixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('rejects an unknown stats key', () => {
  const bad = { ...validFixture, stats: { scouts: 1, surprise: 2 } };
  const result = validateReport(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('stats.surprise')));
});

test('rejects non-integer and negative stats values', () => {
  const nonInteger = validateReport({ ...validFixture, stats: { scouts: 1.5 } });
  assert.equal(nonInteger.ok, false);
  assert.ok(nonInteger.errors.some((e) => e.includes('stats.scouts')));

  const negative = validateReport({ ...validFixture, stats: { carried_forward: -1 } });
  assert.equal(negative.ok, false);
  assert.ok(negative.errors.some((e) => e.includes('stats.carried_forward')));
});

test('rejects non-object stats', () => {
  const result = validateReport({ ...validFixture, stats: [3] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('stats must be an object')));
});

// --- graded fail-on ---

test('countOpenAtOrAbove respects the severity threshold', () => {
  const report = {
    findings: [
      { severity: 'important', verdict: 'confirmed' },
      { severity: 'critical', verdict: 'still_open' },
      { severity: 'minor', verdict: 'confirmed' },
      { severity: 'critical', verdict: 'false_positive' },
    ],
  };
  assert.equal(countOpenAtOrAbove(report, 'critical'), 1);
  assert.equal(countOpenAtOrAbove(report, 'important'), 2);
  assert.equal(countOpenAtOrAbove(report, 'minor'), 3);
});

// --- render ---

test('renderMarkdown reflects JSON as the single source of truth', () => {
  const report = {
    ...validFixture,
    summary: {
      ...validFixture.summary,
      headline: 'Reviewed 1 file; 1 confirmed, 1 false positive.',
      top_actions: ['Add empty-cart guard'],
    },
  };
  const md = renderMarkdown(report);
  assert.ok(md.startsWith('# Code review —'));
  assert.ok(md.includes('Reviewed 1 file'));
  assert.ok(md.includes('## Important')); // F-001 important confirmed in main body
  assert.ok(md.includes('Add empty-cart guard'));
  assert.ok(md.includes('## Appendix A — Rejected findings')); // F-002 false positive
  assert.ok(md.includes('F-002'));
  // false positives never appear in the main severity body
  const mainBody = md.split('## Appendix A')[0];
  assert.ok(!mainBody.includes('SQL injection'));
});

test('renderMarkdown shows downgrade provenance and second opinions', () => {
  const report = {
    ...validFixture,
    summary: { tentative_count: 1, downgraded: 1 },
    findings: [
      {
        id: 'F-001',
        lens: 'architecture',
        location: 'a.ts:1',
        claim: 'coupling',
        severity: 'minor',
        original_severity: 'important',
        verdict: 'downgraded',
        verdict_reason: 'documented',
        second_opinion: { verdict: 'downgraded', verdict_reason: 'concur', agrees: true },
      },
    ],
  };
  const md = renderMarkdown(report);
  assert.ok(md.includes('minor (was important)'));
  assert.ok(md.includes('Second skeptic'));
  assert.ok(md.includes('concur'));
});

test('renderMarkdown includes pipeline stats when present and omits them otherwise', () => {
  const md = renderMarkdown({
    ...validFixture,
    stats: { scouts: 3, skeptics_batched: 2, second_opinions: 1 },
  });
  assert.ok(md.includes('## Pipeline stats'));
  assert.ok(md.includes('**Scouts:** 3'));
  assert.ok(md.includes('**Batched skeptics:** 2'));
  assert.ok(md.includes('**Second opinions:** 1'));

  const withoutStats = renderMarkdown(validFixture);
  assert.ok(!withoutStats.includes('## Pipeline stats'));
});

test('countByVerdict zero-fills every verdict bucket', () => {
  const counts = countByVerdict({ findings: [] });
  assert.equal(counts.confirmed, 0);
  assert.equal(counts.regressed, 0);
});

test('unverified is a real verdict below the threshold, but never for a critical', () => {
  const base = (severity) => ({
    review_id: 'r1',
    kind: 'review',
    created_at: '2026-06-05T16:00:00.000Z',
    scope: { type: 'branch', description: 'b' },
    lenses: ['security'],
    preset: 'quick',
    summary: { tentative_count: 1, unverified: 1 },
    findings: [
      {
        id: 'F-001',
        lens: 'security',
        location: 'a.ts:1',
        claim: 'c',
        severity,
        verdict: 'unverified',
        verdict_reason: 'severity routing: below verify_from, no skeptic dispatched',
      },
    ],
  });

  assert.equal(validateReport(base('minor')).ok, true);
  // `quick` verifies criticals only, so an important can legitimately land here.
  assert.equal(validateReport(base('important')).ok, true);

  const critical = validateReport(base('critical'));
  assert.equal(critical.ok, false);
  assert.match(critical.errors.join('\n'), /never valid for severity=critical/);
});

test('an unknown preset is refused at the schema and the skeleton', () => {
  const report = {
    review_id: 'r1',
    kind: 'review',
    created_at: '2026-06-05T16:00:00.000Z',
    scope: { type: 'branch', description: 'b' },
    lenses: ['security'],
    preset: 'thorough',
    summary: { tentative_count: 0 },
    findings: [],
  };
  const result = validateReport(report);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /preset must be one of/);
  assert.throws(
    () => buildReviewSkeleton({ slug: 's', preset: 'thorough', now: new Date() }),
    /unknown preset/,
  );
  const ok = buildReviewSkeleton({ slug: 's', preset: 'quick', now: new Date() });
  assert.equal(ok.report.preset, 'quick');
});

test('renderMarkdown gives unverified findings their own section, not the appendix', () => {
  const md = renderMarkdown({
    review_id: 'r1',
    kind: 'review',
    created_at: '2026-06-05T16:00:00.000Z',
    scope: { type: 'branch', description: 'b' },
    lenses: ['security'],
    preset: 'quick',
    summary: { tentative_count: 2, confirmed: 1, unverified: 1 },
    findings: [
      {
        id: 'F-001',
        lens: 'security',
        location: 'a.ts:1',
        claim: 'real one',
        severity: 'critical',
        verdict: 'confirmed',
        verdict_reason: 'traced',
      },
      {
        id: 'F-002',
        lens: 'security',
        location: 'b.ts:9',
        claim: 'nit',
        severity: 'minor',
        verdict: 'unverified',
        verdict_reason: 'severity routing: no skeptic dispatched',
      },
    ],
    stats: { scouts: 1, unverified: 1 },
  });

  assert.match(md, /\*\*Preset:\*\* quick/);
  assert.match(md, /## Unverified findings/);
  assert.match(md, /F-002: nit/);
  assert.match(md, /\*\*Unverified:\*\* 1/);
  // The confirmed critical stays in the main body; the unverified nit is not
  // an appendix-A false positive.
  assert.doesNotMatch(md, /Appendix A/);
  const bodyIndex = md.indexOf('## Critical');
  assert.ok(bodyIndex > 0 && bodyIndex < md.indexOf('## Unverified findings'));
});

test('countOpenAtOrAbove counts unverified findings as open at their own severity', () => {
  // A gate must not pass merely because verification was skipped.
  const report = {
    findings: [
      { severity: 'important', verdict: 'unverified' },
      { severity: 'minor', verdict: 'unverified' },
    ],
  };
  assert.equal(countOpenAtOrAbove(report, 'critical'), 0);
  assert.equal(countOpenAtOrAbove(report, 'important'), 1);
  assert.equal(countOpenAtOrAbove(report, 'minor'), 2);
});
