import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs,
  locationFile,
  firstLineNumber,
  isDuplicate,
  dedupeFindings,
  renumberFindings,
  runMerge,
} from './merge-tentative.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function makeFinding(overrides = {}) {
  return {
    id: 'S1-001',
    lens: 'correctness',
    location: 'src/a.ts:10',
    claim: 'claim text',
    evidence: 'evidence text',
    tentative_severity: 'minor',
    confidence: 'medium',
    ...overrides,
  };
}

/**
 * @param {string} dir
 * @param {string} base
 * @param {unknown} content JSON-serialisable content (or a raw string).
 * @returns {string}
 */
function writeScoutFile(dir, base, content) {
  const p = path.join(dir, base);
  const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs parses --dir and rejects unknown args', () => {
  const opts = parseArgs(['--dir', '.reviews/x-tentative']);
  assert.equal(opts.dir, '.reviews/x-tentative');
  assert.equal(opts.help, false);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('parseArgs defaults dir to null and parses --help', () => {
  assert.equal(parseArgs([]).dir, null);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('locationFile strips :line and :start-end suffixes', () => {
  assert.equal(locationFile('services/foo/src/bar.ts:42'), 'services/foo/src/bar.ts');
  assert.equal(locationFile('path/to/x.ts:10-20'), 'path/to/x.ts');
  assert.equal(locationFile('path/to/x.ts'), 'path/to/x.ts');
});

test('firstLineNumber extracts the first line number, null when absent', () => {
  assert.equal(firstLineNumber('a.ts:42'), 42);
  assert.equal(firstLineNumber('a.ts:10-20'), 10);
  assert.equal(firstLineNumber('a.ts'), null);
});

test('isDuplicate requires same file, same lens, lines within ±5', () => {
  const base = makeFinding({ location: 'a.ts:10' });
  assert.equal(isDuplicate(base, makeFinding({ id: 'S2-001', location: 'a.ts:15' })), true);
  assert.equal(isDuplicate(base, makeFinding({ id: 'S2-002', location: 'a.ts:5' })), true);
  // 6 lines apart — NOT duplicates.
  assert.equal(isDuplicate(base, makeFinding({ id: 'S2-003', location: 'a.ts:16' })), false);
  assert.equal(isDuplicate(base, makeFinding({ id: 'S2-004', location: 'a.ts:4' })), false);
  // Different file or lens — never duplicates.
  assert.equal(isDuplicate(base, makeFinding({ id: 'S2-005', location: 'b.ts:10' })), false);
  assert.equal(
    isDuplicate(base, makeFinding({ id: 'S2-006', location: 'a.ts:10', lens: 'security' })),
    false,
  );
});

test('isDuplicate: no line number only dupes another no-line finding in the same file', () => {
  const noLine = makeFinding({ id: 'S1-001', location: 'a.ts' });
  assert.equal(isDuplicate(noLine, makeFinding({ id: 'S2-001', location: 'a.ts' })), true);
  assert.equal(isDuplicate(noLine, makeFinding({ id: 'S2-002', location: 'a.ts:3' })), false);
  assert.equal(isDuplicate(makeFinding({ id: 'S2-003', location: 'a.ts:3' }), noLine), false);
});

// ---------------------------------------------------------------------------
// dedupeFindings
// ---------------------------------------------------------------------------

test('dedupeFindings keeps higher severity and records loser id in related', () => {
  const minor = makeFinding({ id: 'S1-001', location: 'a.ts:10', tentative_severity: 'minor' });
  const critical = makeFinding({
    id: 'S2-001',
    location: 'a.ts:12',
    tentative_severity: 'critical',
  });
  const { survivors, collapsed } = dedupeFindings([minor, critical]);
  assert.equal(survivors.length, 1);
  assert.equal(collapsed, 1);
  assert.equal(survivors[0].id, 'S2-001');
  assert.equal(survivors[0].tentative_severity, 'critical');
  assert.deepEqual(survivors[0].related, ['S1-001']);
});

test('dedupeFindings ties on severity break by higher confidence', () => {
  const low = makeFinding({ id: 'S1-001', location: 'a.ts:10', confidence: 'low' });
  const high = makeFinding({ id: 'S2-001', location: 'a.ts:11', confidence: 'high' });
  const { survivors } = dedupeFindings([low, high]);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].id, 'S2-001');
  assert.deepEqual(survivors[0].related, ['S1-001']);
});

test('dedupeFindings full tie keeps the first encountered', () => {
  const first = makeFinding({ id: 'S1-001', location: 'a.ts:10' });
  const second = makeFinding({ id: 'S2-001', location: 'a.ts:10' });
  const { survivors } = dedupeFindings([first, second]);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].id, 'S1-001');
  assert.deepEqual(survivors[0].related, ['S2-001']);
});

test('dedupeFindings appends to an existing related array without losing entries', () => {
  const winner = makeFinding({
    id: 'S1-001',
    location: 'a.ts:10',
    tentative_severity: 'important',
    related: ['S0-009'],
  });
  const loser = makeFinding({ id: 'S2-001', location: 'a.ts:12', tentative_severity: 'minor' });
  const { survivors } = dedupeFindings([winner, loser]);
  assert.deepEqual(survivors[0].related, ['S0-009', 'S2-001']);
});

test('dedupeFindings does not collapse findings 6 lines apart', () => {
  const a = makeFinding({ id: 'S1-001', location: 'a.ts:10' });
  const b = makeFinding({ id: 'S2-001', location: 'a.ts:16' });
  const { survivors, collapsed } = dedupeFindings([a, b]);
  assert.equal(survivors.length, 2);
  assert.equal(collapsed, 0);
});

// ---------------------------------------------------------------------------
// renumberFindings
// ---------------------------------------------------------------------------

test('renumberFindings sorts by (file, first line, original id) and assigns F-###', () => {
  const findings = [
    makeFinding({ id: 'S3-001', location: 'z.ts:5' }),
    makeFinding({ id: 'S1-002', location: 'a.ts:100' }),
    makeFinding({ id: 'S2-001', location: 'a.ts:1' }),
    makeFinding({ id: 'S1-001', location: 'a.ts:1' }),
  ];
  const renumbered = renumberFindings(findings);
  assert.deepEqual(
    renumbered.map((f) => [f.id, f.location]),
    [
      ['F-001', 'a.ts:1'], // S1-001 before S2-001 (original id tie-break)
      ['F-002', 'a.ts:1'],
      ['F-003', 'a.ts:100'],
      ['F-004', 'z.ts:5'],
    ],
  );
});

test('renumberFindings orders no-line findings before numbered ones in the same file', () => {
  const renumbered = renumberFindings([
    makeFinding({ id: 'S1-001', location: 'a.ts:2' }),
    makeFinding({ id: 'S2-001', location: 'a.ts' }),
  ]);
  assert.deepEqual(
    renumbered.map((f) => [f.id, f.location]),
    [
      ['F-001', 'a.ts'],
      ['F-002', 'a.ts:2'],
    ],
  );
});

// ---------------------------------------------------------------------------
// runMerge — end-to-end against a temp dir
// ---------------------------------------------------------------------------

test('runMerge merges findings across 3 scout files and writes merged.json', () => {
  const dir = tmp('review-merge-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [makeFinding({ id: 'S1-001', location: 'src/b.ts:20' })],
    });
    writeScoutFile(dir, 'scout-2.json', {
      findings: [
        makeFinding({ id: 'S2-001', location: 'src/a.ts:5', lens: 'security' }),
        makeFinding({ id: 'S2-002', location: 'src/c.ts:1' }),
      ],
    });
    writeScoutFile(dir, 'scout-3.json', {
      findings: [makeFinding({ id: 'S3-001', location: 'src/a.ts:50' })],
    });

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 0, result.message);

    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
    assert.equal(merged.findings.length, 4);
    assert.deepEqual(
      merged.findings.map((f) => f.id),
      ['F-001', 'F-002', 'F-003', 'F-004'],
    );
    assert.deepEqual(
      merged.findings.map((f) => f.location),
      ['src/a.ts:5', 'src/a.ts:50', 'src/b.ts:20', 'src/c.ts:1'],
    );

    // Per-file counts, duplicates collapsed, final count in the message.
    assert.ok(result.message.includes('scout-1.json: 1'));
    assert.ok(result.message.includes('scout-2.json: 2'));
    assert.ok(result.message.includes('scout-3.json: 1'));
    assert.ok(/collapsed:\s*0/.test(result.message));
    assert.ok(/final:\s*4/.test(result.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge dedupes across files, keeps higher severity, records loser in related', () => {
  const dir = tmp('review-merge-dupe-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [
        makeFinding({ id: 'S1-001', location: 'src/a.ts:10', tentative_severity: 'minor' }),
      ],
    });
    writeScoutFile(dir, 'scout-2.json', {
      findings: [
        makeFinding({ id: 'S2-001', location: 'src/a.ts:13', tentative_severity: 'critical' }),
      ],
    });

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 0, result.message);

    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
    assert.equal(merged.findings.length, 1);
    assert.equal(merged.findings[0].id, 'F-001');
    assert.equal(merged.findings[0].tentative_severity, 'critical');
    assert.deepEqual(merged.findings[0].related, ['S1-001']);
    assert.ok(/collapsed:\s*1/.test(result.message));
    assert.ok(/final:\s*1/.test(result.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge honors the ±5 window — 6 lines apart stay separate', () => {
  const dir = tmp('review-merge-window-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [makeFinding({ id: 'S1-001', location: 'src/a.ts:10' })],
    });
    writeScoutFile(dir, 'scout-2.json', {
      findings: [makeFinding({ id: 'S2-001', location: 'src/a.ts:16' })],
    });

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 0, result.message);
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
    assert.equal(merged.findings.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge ignores an existing merged.json as input', () => {
  const dir = tmp('review-merge-rerun-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [makeFinding({ id: 'S1-001', location: 'src/a.ts:10' })],
    });
    writeScoutFile(dir, 'merged.json', {
      findings: [makeFinding({ id: 'F-099', location: 'stale.ts:1' })],
    });

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 0, result.message);
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
    assert.equal(merged.findings.length, 1);
    assert.equal(merged.findings[0].location, 'src/a.ts:10');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge exits 1 naming the file on invalid JSON and writes nothing', () => {
  const dir = tmp('review-merge-badjson-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [makeFinding({ id: 'S1-001' })],
    });
    writeScoutFile(dir, 'scout-2.json', '{ not valid json !!!');

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.message.includes('scout-2.json'));
    assert.equal(fs.existsSync(path.join(dir, 'merged.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge exits 1 naming the file when findings array is missing', () => {
  const dir = tmp('review-merge-nofindings-');
  try {
    writeScoutFile(dir, 'scout-1.json', {
      findings: [makeFinding({ id: 'S1-001' })],
    });
    writeScoutFile(dir, 'scout-2.json', { results: [] });

    const result = runMerge({ dir });
    assert.equal(result.exitCode, 1);
    assert.ok(result.message.includes('scout-2.json'));
    assert.ok(/findings/.test(result.message));
    assert.equal(fs.existsSync(path.join(dir, 'merged.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMerge exits 1 without --dir, on a missing dir, and on an empty dir', () => {
  const noDir = runMerge({ dir: null });
  assert.equal(noDir.exitCode, 1);
  assert.ok(/--dir/.test(noDir.message));

  const missing = runMerge({ dir: path.join(tmpdir(), 'no-such-review-merge-dir') });
  assert.equal(missing.exitCode, 1);

  const dir = tmp('review-merge-empty-');
  try {
    const empty = runMerge({ dir });
    assert.equal(empty.exitCode, 1);
    assert.ok(/no input/i.test(empty.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
