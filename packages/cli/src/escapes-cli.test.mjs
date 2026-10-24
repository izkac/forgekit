import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeReport } from './escapes.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

/** Scratch project: a done session whose change added add1, then a fix within the window. */
function project() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-cli-'));
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit({ 'src/a.js': 'old\n' }, 'base', T0 - DAY);
  const head = commit({ 'src/a.js': 'old\nadd1\n' }, 'feat', T0);
  const fix = commit({ 'src/a.js': 'old\nadd1-fixed\n', 'test/a.test.js': 'x\n' }, 'fix add1', T0 + DAY);
  const unrelated = commit({ 'src/b.js': 'b\n' }, 'unrelated', T0 + DAY);
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  const row = { sessionId: 'sess-1', slug: 'feat', phase: 'done', endedAt: new Date(T0 + 60000).toISOString(), commitRange: { base, head } };
  fs.writeFileSync(path.join(dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = path.join(fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-cli-home-')), 'sessions');
  return { dir, fix, unrelated, fleet };
}

function forge(p, args) {
  return spawnSync(process.execPath, [FORGE, 'escapes', ...args], {
    cwd: p.dir,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: p.fleet },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('forge escapes list --json shows the fix as the only candidate', () => {
  const p = project();
  const r = forge(p, ['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.sessions.flatMap((s) => s.candidates.map((c) => c.commit)), [p.fix]);
});

test('forge escapes (no subcommand, not a TTY) lists in text', () => {
  const p = project();
  const r = forge(p, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(p.fix.slice(0, 7)));
  assert.match(r.stdout, /fix add1/);
});

test('confirm takes the fix commit test, lands in the ledger, and drops out of the list', () => {
  const p = project();
  const c = forge(p, ['confirm', 'sess-1', p.fix.slice(0, 8)]);
  assert.equal(c.status, 0, c.stderr);
  const [line] = fs.readFileSync(path.join(p.dir, '.forge', 'escapes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(line.decision, 'confirmed');
  assert.equal(line.replayTest, 'test/a.test.js');
  assert.equal(line.slug, 'feat');
  const doc = JSON.parse(forge(p, ['list', '--json']).stdout);
  assert.deepEqual(doc.sessions.flatMap((s) => s.candidates), []);
});

test('dismiss records the reason; an unknown session refuses', () => {
  const p = project();
  assert.equal(forge(p, ['dismiss', 'sess-1', p.fix, '--reason', 'follow-up feature']).status, 0);
  const line = JSON.parse(fs.readFileSync(path.join(p.dir, '.forge', 'escapes.jsonl'), 'utf8').trim());
  assert.deepEqual([line.decision, line.reason], ['dismissed', 'follow-up feature']);
  const bad = forge(p, ['dismiss', 'no-such-session', p.fix]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no done session/i);
});

test('confirm without a test in the commit and without --test refuses', () => {
  const p = project();
  const r = forge(p, ['confirm', 'sess-1', p.unrelated]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--test/);
});

test('escapeReport buckets done sessions by month across projects and counts open windows', () => {
  const a = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-report-a-'));
  const b = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-report-b-'));
  const write = (root, name, rows) => {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', name), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  };
  const now = Date.parse('2026-10-20T00:00:00Z');
  write(a, 'sessions.jsonl', [
    { sessionId: 'a1', phase: 'done', endedAt: '2026-09-10T00:00:00.000Z' },
    { sessionId: 'a2', phase: 'done', endedAt: '2026-10-01T00:00:00.000Z' },
    { sessionId: 'a3', phase: 'skipped', endedAt: '2026-10-02T00:00:00.000Z' },
  ]);
  write(a, 'escapes.jsonl', [
    { sessionId: 'a2', commit: 'x', decision: 'confirmed' },
    { sessionId: 'a2', commit: 'y', decision: 'confirmed' },
    { sessionId: 'a1', commit: 'z', decision: 'dismissed' },
  ]);
  write(b, 'sessions.jsonl', [{ sessionId: 'b1', phase: 'done', endedAt: '2026-10-15T00:00:00.000Z' }]);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-report-fleet-'));
  fs.mkdirSync(path.join(b, '.forge', 'sessions', 'b1'), { recursive: true });
  fs.writeFileSync(path.join(fleet, 'b--b1.json'), JSON.stringify({ project: b, projectName: 'b', sessionId: 'b1', phase: 'done', updatedAt: '2026-10-15T00:00:00.000Z' }));
  fs.writeFileSync(path.join(fleet, 'gone--w1.json'), JSON.stringify({ project: path.join(tmpdir(), 'gone-worktree-x'), projectName: 'gone', sessionId: 'w1', phase: 'done', updatedAt: '2026-10-03T00:00:00.000Z' }));

  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = fleet;
  try {
    const report = escapeReport({ cwd: a, now });
    const byMonth = Object.fromEntries(report.months.map((m) => [m.month, m]));
    assert.deepEqual(byMonth['2026-09'], { month: '2026-09', done: 1, escaped: 0, rate: 0, open: 0 });
    // a2 (escaped), b1 (window open), w1 (registry only — a deleted worktree)
    assert.deepEqual(byMonth['2026-10'], { month: '2026-10', done: 3, escaped: 1, rate: 1 / 3, open: 1 });
    assert.equal(report.total.done, 4);
    assert.equal(report.total.escaped, 1);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
});

test('forge escapes report --json runs', () => {
  const p = project();
  const r = forge(p, ['report', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).total.done, 1);
});
