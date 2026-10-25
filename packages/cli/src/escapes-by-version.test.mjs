import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doneSessions, escapeReport } from './escapes.mjs';

/**
 * `forge escapes report --by version` (escape-gaps 3.2): one row per forgekit
 * release recorded on the digest row, sessions without one under `unknown`.
 */

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const WINDOW = 14 * 86400000;
const DAY = 86400000;
const NOW = Date.parse('2026-10-12T00:00:00Z');

/**
 * Done sessions listed out of version order, with 0.3.9 vs 0.3.10 to catch a
 * string sort. Done times are relative to `now`, so the CLI (which reads the
 * real clock) sees the same open and closed windows as `escapeReport` does.
 */
function fixture(now = NOW) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-version-'));
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-version-fleet-'));
  const done = (sessionId, daysAgo, forgekitVersion) => ({
    sessionId,
    phase: 'done',
    endedAt: new Date(now - daysAgo * DAY).toISOString(),
    ...(forgekitVersion === undefined ? {} : { forgekitVersion }),
  });
  const rows = [
    done('old1', 40, '0.3.9'),
    done('new1', 20, '0.3.10'),
    done('new2', 5, '0.3.10'),
    done('new3', 1, '0.3.10'),
    done('none1', 30),
    done('none2', 2),
  ];
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'sessions.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  // old1 and new2 each have a confirmed Escape.
  fs.writeFileSync(
    path.join(root, '.forge', 'escapes.jsonl'),
    ['old1', 'new2'].map((sessionId) => JSON.stringify({ sessionId, commit: 'x', decision: 'confirmed' })).join('\n') + '\n',
  );
  return { root, fleet, rows, now, escaped: new Set(['old1', 'new2']) };
}

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

/** The expected row for one version, computed from the fixture's own rows. */
function expectedRow(f, version) {
  const members = f.rows.filter((r) => (r.forgekitVersion ?? 'unknown') === version);
  const escaped = members.filter((r) => f.escaped.has(r.sessionId)).length;
  const open = members.filter((r) => f.now - Date.parse(r.endedAt) < WINDOW).length;
  return { version, done: members.length, escaped, rate: escaped / members.length, open };
}

test('doneSessions carries forgekitVersion from the digest row', () => {
  const f = fixture();
  const sessions = withFleet(f, () => doneSessions({ cwd: f.root }));
  for (const row of f.rows) {
    assert.equal(sessions.find((s) => s.sessionId === row.sessionId).forgekitVersion, row.forgekitVersion ?? null, row.sessionId);
  }
});

test('escapeReport by version: one row per release in version order, unknown last', () => {
  const f = fixture();
  const report = withFleet(f, () => escapeReport({ cwd: f.root, now: NOW, by: 'version' }));

  const expected = ['0.3.9', '0.3.10', 'unknown'].map((v) => expectedRow(f, v));
  assert.deepEqual(report.byVersion, expected);
  // discriminating: the fixture has sessions on every side of each rule
  assert.ok(expected.every((e) => e.done > 0));
  assert.ok(expected[1].escaped > 0 && expected[1].escaped < expected[1].done, '0.3.10 mixes escaped and clean');
  assert.ok(expected[1].open > 0 && expected[1].open < expected[1].done, '0.3.10 mixes open and closed windows');
  assert.equal(report.byVersion.reduce((n, e) => n + e.done, 0), report.total.done);
});

test('escapeReport without --by leaves the report as it was', () => {
  const f = fixture();
  const report = withFleet(f, () => escapeReport({ cwd: f.root, now: NOW }));
  assert.deepEqual(Object.keys(report), ['projects', 'months', 'byPace', 'total', 'inferred']);
});

function runCli(f, extra) {
  return spawnSync(process.execPath, [FORGE, 'escapes', 'report', ...extra], {
    cwd: f.root,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('forge escapes report --by version --json carries byVersion', () => {
  const f = fixture(Date.now());
  const r = runCli(f, ['--by', 'version', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.byVersion.map((e) => e.version), ['0.3.9', '0.3.10', 'unknown']);
  assert.equal(report.byVersion.find((e) => e.version === '0.3.10').done, expectedRow(f, '0.3.10').done);
});

test('forge escapes report --by version prints a VERSION table', () => {
  const f = fixture(Date.now());
  const r = runCli(f, ['--by', 'version']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split('\n');
  const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(5);
  const row = (e) => `${e.version.padEnd(10)}${String(e.done).padStart(4)}  ${String(e.escaped).padStart(7)}  ${pct(e.rate)}  ${String(e.open).padStart(4)}`;
  const header = out.findIndex((l) => /^VERSION\s+DONE\s+ESCAPED\s+RATE\s+OPEN$/.test(l));
  assert.ok(header >= 0, r.stdout);
  ['0.3.9', '0.3.10', 'unknown'].forEach((v, i) => assert.equal(out[header + 1 + i].trimEnd(), row(expectedRow(f, v)).trimEnd()));
});

test('forge escapes report with no --by is unchanged: no VERSION table, no byVersion', () => {
  const f = fixture();
  const text = runCli(f, []);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(!/VERSION/.test(text.stdout), text.stdout);
  assert.ok(/^MONTH\s+DONE/m.test(text.stdout) && /^PACE\s+DONE/m.test(text.stdout));
  const json = JSON.parse(runCli(f, ['--json']).stdout);
  assert.equal('byVersion' in json, false);
});

test('forge escapes report --by with an unknown grouping fails', () => {
  const f = fixture(Date.now());
  const r = runCli(f, ['--by', 'color']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--by/);
});
