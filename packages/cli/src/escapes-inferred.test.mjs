import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeCandidates, escapeReport, inferNestedWindows, pendingCandidates } from './escapes.mjs';

/**
 * A done session recorded before per-repository ranges has only start/end
 * times. Each nested repo that exists now gets the commits whose committer
 * time falls in `[startedAt, endedAt]`; a commit in several windows goes to
 * the shortest. Candidates from such a range are marked `inferred: "time-window"`
 * and `forge escapes report` counts them apart.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'escapes-cli.mjs');
const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const OLD = 'old1\nold2\nold3\n';
const ADDED = 'add1\nadd2\nadd3\nadd4\n';
const iso = (ms) => new Date(ms).toISOString();

function repoAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) },
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
  return { dir, git, commit };
}

/** A project root repo (committed first) with a nested repo `volo_web` created after it. */
function project() {
  const root = repoAt(fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-inferred-')));
  fs.mkdirSync(path.join(root.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root.dir, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
  root.commit({ 'src/r.js': OLD }, 'base', T0 - 30 * DAY);
  const nested = repoAt(path.join(root.dir, 'volo_web'));
  return { root, nested };
}

const win = (sessionId, startMs, endMs, extra = {}) => ({ sessionId, slug: sessionId, startedAt: iso(startMs), doneAt: iso(endMs), ...extra });
const sorted = (xs) => [...xs].sort();

test('window inclusion: commits inside [startedAt, endedAt] are inferred, the boundaries included, others not', () => {
  const { root, nested } = project();
  const before = nested.commit({ 'a.js': OLD }, 'before', T0 - HOUR);
  const atStart = nested.commit({ 'a.js': OLD + 'x1\n' }, 'at start', T0);
  const inside = nested.commit({ 'a.js': OLD + 'x2\n' }, 'inside', T0 + HOUR);
  const atEnd = nested.commit({ 'a.js': OLD + 'x3\n' }, 'at end', T0 + 4 * HOUR);
  const after = nested.commit({ 'a.js': OLD + 'x4\n' }, 'after', T0 + 5 * HOUR);
  const map = inferNestedWindows({ cwd: root.dir, sessions: [win('s1', T0, T0 + 4 * HOUR)] });
  assert.deepEqual(sorted(map.get('s1').volo_web), sorted([atStart, inside, atEnd]));
  for (const excluded of [before, after]) assert.ok(!map.get('s1').volo_web.includes(excluded));
});

test('a commit in several windows belongs only to the session with the shortest window', () => {
  const { root, nested } = project();
  const inBoth = nested.commit({ 'a.js': OLD }, 'in both windows', T0 + 2 * HOUR);
  const longOnly = nested.commit({ 'a.js': OLD + 'x\n' }, 'long window only', T0 + 6 * HOUR);
  const long = win('long', T0, T0 + 10 * HOUR);
  const short = win('short', T0 + HOUR, T0 + 3 * HOUR);
  // Both listings orders, so the winner cannot come from the input order.
  for (const sessions of [[long, short], [short, long]]) {
    const map = inferNestedWindows({ cwd: root.dir, sessions });
    assert.deepEqual(map.get('short').volo_web, [inBoth]);
    assert.deepEqual(map.get('long').volo_web, [longOnly]);
  }
});

test('a session with recorded nested ranges, or without a usable window, is not inferred', () => {
  const { root, nested } = project();
  nested.commit({ 'a.js': OLD }, 'inside', T0 + HOUR);
  const recorded = win('recorded', T0, T0 + 4 * HOUR, { nestedCommitRanges: {} });
  const noStart = { sessionId: 'nostart', doneAt: iso(T0 + 4 * HOUR) };
  const map = inferNestedWindows({ cwd: root.dir, sessions: [recorded, noStart] });
  assert.equal(map.size, 0);
});

/** An inferred session whose window holds the change commit; a fix lands afterwards. */
function withInferredChange() {
  const { root, nested } = project();
  nested.commit({ 'a.js': OLD, 'test/a.test.js': 't0\n' }, 'base', T0 - DAY);
  const change = nested.commit({ 'a.js': OLD + ADDED }, 'feat: nested change', T0 + HOUR);
  const session = win('s1', T0, T0 + 2 * HOUR);
  const fix = nested.commit({ 'a.js': OLD + ADDED.replace('add1', 'add1-fixed'), 'test/a.test.js': 't1\n' }, 'fix: add1', T0 + DAY);
  return { root, nested, change, fix, session };
}

test('candidates from an inferred window carry inferred: "time-window" and their repo', () => {
  const f = withInferredChange();
  const inferredCommits = inferNestedWindows({ cwd: f.root.dir, sessions: [f.session] }).get('s1');
  const result = escapeCandidates({ cwd: f.root.dir, session: { ...f.session, inferredCommits } });
  assert.deepEqual(result.candidates.map((c) => [c.commit, c.repo, c.inferred, c.files]), [[f.fix, 'volo_web', 'time-window', ['a.js']]]);
  // The change's own commit is never its own Escape, and the root having no range does not skip the session.
  assert.equal(result.skipped, null);
});

test('a candidate from a recorded range carries no inferred marker', () => {
  const f = withInferredChange();
  const base = f.nested.git(['rev-parse', `${f.change}^`]);
  const session = { ...f.session, nestedCommitRanges: { volo_web: { base, head: f.change } } };
  const result = escapeCandidates({ cwd: f.root.dir, session });
  assert.deepEqual(result.candidates.map((c) => c.commit), [f.fix]);
  assert.equal(result.candidates[0].inferred, undefined);
});

test('pendingCandidates infers from sessions.jsonl rows that have only start and end times', () => {
  const f = withInferredChange();
  const row = { sessionId: 's1', slug: 's1', phase: 'done', startedAt: f.session.startedAt, endedAt: f.session.doneAt };
  fs.writeFileSync(path.join(f.root.dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-inferred-fleet-'));
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = fleet;
  try {
    const sessions = pendingCandidates({ cwd: f.root.dir });
    assert.deepEqual(sessions.flatMap((s) => s.candidates.map((c) => [c.commit, c.repo, c.inferred])), [[f.fix, 'volo_web', 'time-window']]);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
});

test('confirming an inferred nested candidate records its repo and the inferred marker', () => {
  const f = withInferredChange();
  const row = { sessionId: 's1', slug: 's1', phase: 'done', startedAt: f.session.startedAt, endedAt: f.session.doneAt };
  fs.writeFileSync(path.join(f.root.dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-inferred-fleet-'));
  const r = spawnSync(process.execPath, [CLI, 'confirm', 's1', f.fix], { cwd: f.root.dir, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: fleet } });
  assert.equal(r.status, 0, r.stderr);
  const [entry] = fs.readFileSync(path.join(f.root.dir, '.forge', 'escapes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([entry.commit, entry.repo, entry.inferred, entry.replayTest], [f.fix, 'volo_web', 'time-window', 'test/a.test.js']);
});

/** A project whose ledger confirms Escapes for four sessions: inferred only, mixed, recorded only, and one open. */
function reportFixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-inferred-report-'));
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  const done = (sessionId) => ({ sessionId, phase: 'done', endedAt: '2026-10-01T00:00:00.000Z' });
  const rows = ['inferredOnly', 'mixed', 'recordedOnly', 'clean'].map(done);
  fs.writeFileSync(path.join(dir, '.forge', 'sessions.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const decision = (sessionId, commit, inferred) => ({ sessionId, commit, decision: 'confirmed', inferred });
  const decisions = [
    decision('inferredOnly', 'a1', 'time-window'),
    decision('mixed', 'b1', 'time-window'),
    decision('mixed', 'b2', null),
    decision('recordedOnly', 'c1', null),
  ];
  fs.writeFileSync(path.join(dir, '.forge', 'escapes.jsonl'), `${decisions.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const fleet = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-inferred-report-fleet-'));
  return { dir, fleet };
}

test('the report counts sessions escaped only through inferred ranges separately', () => {
  const f = reportFixture();
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = f.fleet;
  try {
    const report = escapeReport({ cwd: f.dir });
    assert.equal(report.total.escaped, 3, 'inferred escapes still count as escapes');
    assert.equal(report.inferred.escaped, 1, 'only the session whose every confirmation is inferred');
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
  const r = spawnSync(process.execPath, [CLI, 'report'], { cwd: f.dir, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: f.fleet } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inferred.*\b1\b/i);
});
