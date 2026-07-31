/**
 * Pins isHighRiskText against the thorough-re corpus (convergence plan W5 / F11).
 * A future THOROUGH_RE narrowing must keep this green or deliberately update
 * expects with a measured rationale — failure names every flipped sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHighRiskText } from './preferences.mjs';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'thorough-re-corpus.json',
);

test('thorough-re corpus pins isHighRiskText for every sentence', () => {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = doc.sentences;
  assert.ok(Array.isArray(rows) && rows.length > 0, 'fixture must list sentences');

  const risky = rows.filter((r) => r.expect === 'risky');
  const benign = rows.filter((r) => r.expect === 'benign');
  assert.ok(risky.length >= 8, `need ≥8 risky rows, got ${risky.length}`);
  assert.ok(benign.length >= 3, `need ≥3 benign rows, got ${benign.length}`);
  assert.ok(
    rows.some((r) => String(r.source).startsWith('F11') && r.expect === 'risky'),
    'F11 risky examples must be present',
  );
  assert.ok(
    rows.some((r) => r.source === 'F11-hardwrap'),
    'hard-wrapped F11 variants must be present',
  );
  assert.ok(
    rows.some((r) => String(r.source).includes('archive/')),
    'archive-sourced rows must be present',
  );

  const mismatches = [];
  for (const row of rows) {
    const actual = isHighRiskText(row.text) ? 'risky' : 'benign';
    if (actual !== row.expect) {
      mismatches.push(`${row.id}: expect ${row.expect}, got ${actual}`);
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `isHighRiskText classification drifted for:\n${mismatches.join('\n')}`,
  );
});
