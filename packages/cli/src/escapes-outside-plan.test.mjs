import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeCandidates } from './escapes.mjs';

const FORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

/** A scratch repo (plan engine dir: specs/) whose commits carry controlled dates. */
function repo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-outside-'));
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
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

const A_OLD = 'a-old\n';
const A_ADD = 'a1\na2\n';
const N_OLD = 'n-old\n';
const N_ADD = 'n1\nn2\n';

/**
 * base → change commit → done. The change adds lines to src/a.js (named by the
 * plan) and to notes.md (not named); `withPlan: false` leaves the plan-engine
 * dir out of the range altogether.
 */
function withChange({ withPlan = true, plan = '- [ ] 1.1 add the two lines in src/a.js\n' } = {}) {
  const r = repo();
  const base = r.commit({ 'src/a.js': A_OLD, 'notes.md': N_OLD }, 'base', T0 - DAY);
  const files = { 'src/a.js': A_OLD + A_ADD, 'notes.md': N_OLD + N_ADD };
  if (withPlan) files['specs/changes/c/tasks.md'] = plan;
  const head = r.commit(files, 'feat: change', T0);
  const sessionRow = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: new Date(T0 + 3600000).toISOString(), commitRange: { base, head } };
  const session = { sessionId: 's1', slug: 'c', doneAt: sessionRow.endedAt, commitRange: { base, head } };
  const fixA = r.commit({ 'src/a.js': A_OLD + A_ADD.replace('a1', 'a1-fixed') }, 'fix: a1', T0 + DAY);
  const fixN = r.commit({ 'notes.md': N_OLD + N_ADD.replace('n1', 'n1-fixed') }, 'fix: n1', T0 + 2 * DAY);
  return { ...r, sessionRow, session, fixA, fixN };
}

test('a hit file the plan never names is flagged outside the plan; a named one is not', () => {
  const r = withChange();
  const result = escapeCandidates({ cwd: r.dir, session: r.session });
  assert.deepEqual(result.candidates.map((c) => c.commit), [r.fixA, r.fixN]);
  const [a, n] = result.candidates;
  assert.deepEqual(a.outsidePlan, []);
  assert.deepEqual(n.outsidePlan, ['notes.md']);
  // the flag labels; it never changes what the candidate is
  assert.deepEqual([a.files, a.lines], [['src/a.js'], 1]);
  assert.deepEqual([n.files, n.lines], [['notes.md'], 1]);
});

test('a plan that names notes.md clears the flag (discriminates the match from always-flag)', () => {
  const r = withChange({ plan: '- [ ] 1.1 add the lines in src/a.js\n- [ ] 1.2 and the lines in notes.md\n' });
  const result = escapeCandidates({ cwd: r.dir, session: r.session });
  assert.deepEqual(result.candidates.map((c) => c.commit), [r.fixA, r.fixN]);
  for (const c of result.candidates) assert.deepEqual(c.outsidePlan, [], c.commit);
});

test('a range with no plan-engine files flags nothing', () => {
  const r = withChange({ withPlan: false });
  const result = escapeCandidates({ cwd: r.dir, session: r.session });
  assert.deepEqual(result.candidates.map((c) => c.commit), [r.fixA, r.fixN]);
  for (const c of result.candidates) assert.deepEqual(c.outsidePlan, [], c.commit);
});

/** Run `forge escapes …` in the scratch repo with a throwaway registry. */
function forge(r, args) {
  fs.writeFileSync(path.join(r.dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(r.sessionRow)}\n`);
  const fleet = path.join(fs.mkdtempSync(path.join(tmpdir(), 'forge-escapes-outside-home-')), 'sessions');
  return spawnSync(process.execPath, [FORGE, 'escapes', ...args], {
    cwd: r.dir,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: fleet },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('forge escapes list prints the possible-sweep label under the flagged candidate only', () => {
  const r = withChange();
  const res = forge(r, ['list']);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.split('\n');
  const label = '  outside plan: notes.md — possible sweep (F16)';
  const at = out.indexOf(label);
  assert.ok(at > 0, res.stdout);
  assert.ok(out[at - 1].includes(r.fixN.slice(0, 7)), 'label sits directly under the notes.md candidate');
  assert.equal(out.filter((l) => l.includes('possible sweep')).length, 1);
  assert.ok(out.some((l) => l.includes(r.fixA.slice(0, 7))));
});

test('forge escapes list --json carries outsidePlan, and prints no label without plan files', () => {
  const r = withChange();
  const doc = JSON.parse(forge(r, ['list', '--json']).stdout);
  const byCommit = Object.fromEntries(doc.sessions.flatMap((s) => s.candidates).map((c) => [c.commit, c.outsidePlan]));
  assert.deepEqual(byCommit, { [r.fixA]: [], [r.fixN]: ['notes.md'] });
  const bare = withChange({ withPlan: false });
  const res = forge(bare, ['list']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /possible sweep/);
});
