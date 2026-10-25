import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeReport } from './escapes.mjs';
import { CONCRETE_PACES } from './preferences.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const WINDOW = 14 * 86400000;
const NOW = Date.parse('2026-10-12T00:00:00Z');

/**
 * Two projects plus a fleet registry. Rows are listed out of pace order on
 * purpose (brisk before standard, a custom pace, no-pace first) so the output
 * order has to come from the report, not from the fixture.
 */
function fixture() {
  const a = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-pace-a-'));
  const b = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-pace-b-'));
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-pace-fleet-'));
  const write = (root, name, rows) => {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', name), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  };
  const done = (sessionId, endedAt, pace) => ({ sessionId, phase: 'done', endedAt, ...(pace === undefined ? {} : { pace }) });
  const rowsA = [
    done('nopace', '2026-09-03T00:00:00.000Z'),
    done('brisk1', '2026-09-05T00:00:00.000Z', 'brisk'),
    done('std1', '2026-10-01T00:00:00.000Z', 'standard'),
    done('std2', '2026-10-02T00:00:00.000Z', 'standard'),
    done('digestwins', '2026-10-03T00:00:00.000Z', 'thorough'),
  ];
  const rowsB = [done('custom1', '2026-10-04T00:00:00.000Z', 'zz-custom'), done('regfallback', '2026-10-05T00:00:00.000Z')];
  write(a, 'sessions.jsonl', rowsA);
  write(b, 'sessions.jsonl', rowsB);
  // std1 has a confirmed Escape; the digest-less registry pace for `regfallback` fills in.
  write(a, 'escapes.jsonl', [{ sessionId: 'std1', commit: 'x', decision: 'confirmed' }]);
  const entry = (project, projectName, sessionId, extra = {}) => {
    // listFleet drops an entry whose project exists but whose session dir does not.
    if (fs.existsSync(project)) fs.mkdirSync(path.join(project, '.forge', 'sessions', sessionId), { recursive: true });
    fs.writeFileSync(
      path.join(fleet, `${projectName}--${sessionId}.json`),
      JSON.stringify({ project, projectName, sessionId, phase: 'done', updatedAt: '2026-10-06T00:00:00.000Z', ...extra }),
    );
  };
  entry(b, 'b', 'regfallback', { pace: 'lite' });
  entry(b, 'b', 'custom1', { pace: 'brisk' }); // digest says zz-custom: the digest row wins
  entry(a, 'a', 'digestwins', { pace: 'lite' }); // digest says thorough
  // A deleted worktree: only the registry remembers it, and it carries a pace.
  entry(path.join(tmpdir(), 'forge-escapes-pace-gone-worktree'), 'gone', 'gone1', { pace: 'brisk' });
  return { a, b, fleet, rows: [...rowsA, ...rowsB] };
}

/** Run `fn` with FORGEKIT_FLEET_DIR pointed at the fixture's registry. */
function withFleet(f, fn) {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = f.fleet;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
}

/** The pace each session id should land in, from the fixture's own data. */
function expectedPaces() {
  return {
    nopace: 'unknown',
    brisk1: 'brisk',
    std1: 'standard',
    std2: 'standard',
    digestwins: 'thorough',
    custom1: 'zz-custom',
    regfallback: 'lite',
    gone1: 'brisk',
  };
}

/** When each session reached done: its digest row, else its registry entry (gone1). */
const doneAtOf = (f) => ({ ...Object.fromEntries(f.rows.map((r) => [r.sessionId, r.endedAt])), gone1: '2026-10-06T00:00:00.000Z' });

test('byPace buckets done sessions by recorded pace, in thorough..lite, other, unknown order', () => {
  const f = fixture();
  const report = withFleet(f, () => escapeReport({ cwd: f.a, now: NOW }));
  const paces = expectedPaces();
  const escapedIds = new Set(['std1']);
  const doneAt = doneAtOf(f);
  const ids = Object.keys(paces);
  const names = [...new Set(Object.values(paces))];
  const order = [
    ...CONCRETE_PACES.filter((p) => names.includes(p)),
    ...names.filter((p) => !CONCRETE_PACES.includes(p) && p !== 'unknown').sort(),
    ...names.filter((p) => p === 'unknown'),
  ];
  const expected = order.map((pace) => {
    const members = ids.filter((id) => paces[id] === pace);
    const escaped = members.filter((id) => escapedIds.has(id)).length;
    const open = members.filter((id) => NOW - Date.parse(doneAt[id]) < WINDOW).length;
    return { pace, done: members.length, escaped, rate: escaped / members.length, open };
  });
  assert.ok(order.indexOf('standard') >= 0 && order.at(-1) === 'unknown');
  const brisk = expected.find((e) => e.pace === 'brisk');
  assert.ok(brisk.open > 0 && brisk.open < brisk.done, 'brisk mixes an open and a closed window');
  assert.deepEqual(report.byPace, expected);
  // the discriminating cases are really in the fixture
  assert.ok(expected.find((e) => e.pace === 'standard').done === 2 && expected.find((e) => e.pace === 'standard').escaped === 1);
  assert.deepEqual(report.byPace.map((e) => e.pace), ['thorough', 'standard', 'brisk', 'lite', 'zz-custom', 'unknown']);
});

test('months and total keep their values alongside byPace', () => {
  const f = fixture();
  const report = withFleet(f, () => escapeReport({ cwd: f.a, now: NOW }));
  const doneAt = doneAtOf(f);
  const monthsOf = (m) => Object.keys(doneAt).filter((id) => doneAt[id].startsWith(m));
  const byMonth = Object.fromEntries(report.months.map((m) => [m.month, m]));
  assert.deepEqual(Object.keys(byMonth), ['2026-09', '2026-10']);
  for (const m of Object.keys(byMonth)) {
    const ids = monthsOf(m);
    const escaped = ids.filter((id) => id === 'std1').length;
    const open = ids.filter((id) => NOW - Date.parse(doneAt[id]) < WINDOW).length;
    assert.deepEqual(byMonth[m], { month: m, done: ids.length, escaped, rate: escaped / ids.length, open });
  }
  assert.equal(report.total.done, Object.keys(doneAt).length);
  assert.equal(report.total.done, report.byPace.reduce((n, e) => n + e.done, 0));
  assert.equal(report.total.escaped, report.byPace.reduce((n, e) => n + e.escaped, 0));
  assert.equal(report.total.open, report.byPace.reduce((n, e) => n + e.open, 0));
  assert.ok(report.total.open > 0, 'fixture must include an open window so the open column is exercised');
});

test('forge escapes report prints the PACE table under the month table', () => {
  const f = fixture();
  const run = (extra) =>
    spawnSync(process.execPath, [FORGE, 'escapes', 'report', ...extra], {
      cwd: f.a,
      encoding: 'utf8',
      env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const j = run(['--json']);
  assert.equal(j.status, 0, j.stderr);
  const report = JSON.parse(j.stdout);
  assert.ok(report.byPace.length > 0);

  const t = run([]);
  assert.equal(t.status, 0, t.stderr);
  const out = t.stdout.split('\n');
  const pct = (r) => `${(r * 100).toFixed(0)}%`.padStart(5);
  const row = (name, b) => `${name.padEnd(10)}${String(b.done).padStart(4)}  ${String(b.escaped).padStart(7)}  ${pct(b.rate)}  ${String(b.open).padStart(4)}`;
  const header = out.findIndex((l) => /^PACE\s+DONE\s+ESCAPED\s+RATE\s+OPEN$/.test(l));
  const monthHeader = out.findIndex((l) => /^MONTH\s+DONE/.test(l));
  const footnote = out.findIndex((l) => l.startsWith('OPEN ='));
  assert.ok(header > monthHeader && header < footnote, t.stdout);
  report.byPace.forEach((b, i) => assert.equal(out[header + 1 + i].trimEnd(), row(b.pace, b).trimEnd()));
  assert.ok(report.byPace.some((b) => b.pace === 'standard' && b.escaped === 1));
});
