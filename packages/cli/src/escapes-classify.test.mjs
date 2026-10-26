import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, pendingCandidates, readDecisions, readTags } from './escapes.mjs';
import { classifyReplay, ENVIRONMENT_SIGNATURES, recordReplay } from './escapes-replay.mjs';

/**
 * Classification of a replay (old run / fix run) and what gets recorded:
 * only a proof is a decision; every other outcome is a tag on a candidate that
 * stays pending.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'escapes-cli.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const OLD = 'old1\nold2\nold3\n';
const ADDED = 'add1\nadd2\nadd3\nadd4\n';
const COMMAND = 'node --test test/a.test.js';

const ok = { exit: 0, output: 'pass', timedOut: false };
const failing = (output = 'AssertionError: expected 5 got -1') => ({ exit: 1, output, timedOut: false });

/** A done session whose change added ADDED to src/a.js, then a fix that rewrote add1 and added a test. */
function project() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-classify-'));
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.json'), '{"plan":{"engine":"specs","dir":"specs"}}\n');
  const base = commit({ 'src/a.js': OLD }, 'base', T0 - DAY);
  const head = commit({ 'src/a.js': OLD + ADDED }, 'feat: change', T0);
  const fix = commit({ 'src/a.js': (OLD + ADDED).replace('add1', 'add1-fixed'), 'test/a.test.js': 'test\n' }, 'fix: add1', T0 + DAY);
  const row = { sessionId: 's1', slug: 'c', phase: 'done', endedAt: new Date(T0 + 3600000).toISOString(), commitRange: { base, head } };
  fs.writeFileSync(path.join(dir, '.forge', 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
  return { dir, fix, git, env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(dir, '.fleet') } };
}

/** Run `fn` with the fleet registry pointed at the fixture's own empty directory. */
function withFleet(p, fn) {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = p.env.FORGEKIT_FLEET_DIR;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
}

const pendingCommits = (p) => withFleet(p, () => pendingCandidates({ cwd: p.dir }).flatMap((s) => s.candidates));
const record = (p, old, fix) =>
  recordReplay({ cwd: p.dir, sessionId: 's1', slug: 'c', candidate: { commit: p.fix, repo: '.', subject: 'fix: add1' }, testPath: 'test/a.test.js', command: COMMAND, old, fix });

test('classifyReplay: old fails, fix passes, no environment signature -> confirmed', () => {
  assert.deepEqual(classifyReplay({ old: failing(), fix: ok }), { outcome: 'confirmed' });
});

test('classifyReplay: every environment signature on the old run -> environment, never confirmed', () => {
  const messages = [
    "Error: Cannot find module '../src/new-helper.js'",
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find package',
    'code: MODULE_NOT_FOUND',
    "SyntaxError: The requested module './x.js' does not provide an export named 'y'",
    'SyntaxError: Unexpected token',
  ];
  for (const m of messages) {
    assert.ok(ENVIRONMENT_SIGNATURES.test(m), m);
    assert.deepEqual(classifyReplay({ old: failing(m), fix: ok }), { outcome: 'environment' }, m);
  }
  assert.equal(ENVIRONMENT_SIGNATURES.test('AssertionError: expected 5 got -1'), false);
});

const OTHER_ECOSYSTEMS = {
  'pytest ModuleNotFoundError': "ModuleNotFoundError: No module named 'helper'",
  'pytest ImportError': "ImportError: cannot import name 'helper' from 'pkg'",
  'vitest unresolved import': 'Error: Failed to resolve import "../src/helper" from "test/a.test.ts"',
  'esbuild unresolved path': 'X [ERROR] Could not resolve "./helper"',
  'go undefined symbol': './a_test.go:12:9: undefined: helper',
  'go missing package': 'a_test.go:4:2: cannot find package "example.com/helper" in any of',
};
for (const [name, message] of Object.entries(OTHER_ECOSYSTEMS)) {
  test(`classifyReplay: ${name} on the old run -> environment, never confirmed`, () => {
    assert.ok(ENVIRONMENT_SIGNATURES.test(message), message);
    assert.deepEqual(classifyReplay({ old: failing(message), fix: ok }), { outcome: 'environment' });
  });
}

test('classifyReplay: an old run with no exit code (crash, signal) is undecided (no-exit), never confirmed', () => {
  const crashed = { exit: null, output: 'Killed', timedOut: false };
  assert.deepEqual(classifyReplay({ old: crashed, fix: ok }), { outcome: 'undecided', reason: 'no-exit' });
});

test('classifyReplay: neither run could start -> undecided with the spawn error', () => {
  const gone = (error) => ({ exit: null, output: error, timedOut: false, error });
  assert.deepEqual(classifyReplay({ old: gone('spawn npm ENOENT'), fix: gone('spawn npm ENOENT') }), {
    outcome: 'undecided',
    reason: 'cannot-start: spawn npm ENOENT',
  });
  // Only one side failing to start is not "cannot start": the fix run failing is an environment problem.
  assert.deepEqual(classifyReplay({ old: failing(), fix: gone('spawn EPERM') }), { outcome: 'environment' });
});

test('recordReplay: a run that could not start is tagged undecided with the reason and stays pending', () => {
  const p = project();
  const gone = { exit: null, output: 'spawn nope ENOENT', timedOut: false, error: 'spawn nope ENOENT' };
  assert.deepEqual(record(p, gone, gone), { outcome: 'undecided', reason: 'cannot-start: spawn nope ENOENT' });
  assert.deepEqual(readDecisions(p.dir), []);
  assert.equal(pendingCommits(p)[0].tag.reason, 'cannot-start: spawn nope ENOENT');
});

test('classifyReplay: fix run failing -> environment, whatever the old run said', () => {
  assert.deepEqual(classifyReplay({ old: failing(), fix: failing('boom') }), { outcome: 'environment' });
  assert.deepEqual(classifyReplay({ old: failing(), fix: { exit: null, output: 'spawn ENOENT', timedOut: false } }), { outcome: 'environment' });
});

test('classifyReplay: old run passing -> not-reproduced', () => {
  assert.deepEqual(classifyReplay({ old: ok, fix: ok }), { outcome: 'not-reproduced' });
});

test('classifyReplay: a timeout on either run -> undecided (timeout)', () => {
  const hung = { exit: null, output: '', timedOut: true };
  assert.deepEqual(classifyReplay({ old: hung, fix: { exit: null, output: '', timedOut: false } }), { outcome: 'undecided', reason: 'timeout' });
  assert.deepEqual(classifyReplay({ old: failing(), fix: hung }), { outcome: 'undecided', reason: 'timeout' });
});

test('recordReplay: a confirmed replay is an auto decision carrying the command, both exit codes and the replay test', () => {
  const p = project();
  const res = record(p, { exit: 3, output: 'AssertionError', timedOut: false }, ok);
  assert.deepEqual(res, { outcome: 'confirmed', reason: null });
  const [d, ...more] = readDecisions(p.dir);
  assert.equal(more.length, 0);
  assert.equal(d.decision, 'confirmed');
  assert.equal(d.auto, true);
  assert.equal(d.command, COMMAND);
  assert.equal(d.oldExit, 3);
  assert.equal(d.fixExit, 0);
  assert.equal(d.replayTest, 'test/a.test.js');
  assert.equal(d.commit, p.fix);
  assert.deepEqual(readTags(p.dir), []);
  assert.deepEqual(pendingCommits(p), []);
});

test('recordReplay: environment, not-reproduced and undecided are tags, not decisions; the candidate stays pending', () => {
  const p = project();
  const cases = [
    [failing('Cannot find module x'), ok, { tag: 'environment', reason: null }],
    [ok, ok, { tag: 'not-reproduced', reason: null }],
    [{ exit: null, output: '', timedOut: true }, ok, { tag: 'undecided', reason: 'timeout' }],
  ];
  for (const [old, fix, want] of cases) {
    record(p, old, fix);
    assert.deepEqual(readDecisions(p.dir), [], want.tag);
    const [tag, ...more] = readTags(p.dir);
    assert.equal(more.length, 0, 'latest per (session, commit) wins');
    assert.equal(tag.tag, want.tag);
    assert.equal(tag.reason, want.reason);
    assert.equal(tag.commit, p.fix);
    const pending = pendingCommits(p);
    assert.deepEqual(pending.map((c) => c.commit), [p.fix], `${want.tag} candidate stays pending`);
    assert.equal(pending[0].tag.tag, want.tag);
    assert.equal(pending[0].tag.reason, want.reason);
  }
});

test('a tag is superseded by a later confirmation, and `forge escapes list` shows the tag beside the candidate', () => {
  const p = project();
  record(p, ok, ok);
  const list = spawnSync(process.execPath, [CLI, 'list'], { cwd: p.dir, encoding: 'utf8', env: p.env });
  assert.equal(list.status, 0, list.stderr);
  const line = list.stdout.split('\n').find((l) => l.includes(p.fix.slice(0, 7)));
  assert.ok(line, list.stdout);
  assert.match(line, /not-reproduced/);
  record(p, failing(), ok);
  assert.deepEqual(pendingCommits(p), []);
});

test('dismiss overrides an auto-confirm', () => {
  const p = project();
  record(p, failing(), ok);
  assert.equal(readDecisions(p.dir)[0].auto, true);
  const res = decide({ cwd: p.dir, sessionId: 's1', commit: p.fix, decision: 'dismissed', reason: 'env flake' });
  assert.equal(res.ok, true, res.error);
  const lines = readDecisions(p.dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'dismissed');
  assert.equal(lines[0].auto, undefined);
  assert.deepEqual(pendingCommits(p), []);
});

test('a manual confirmation carries none of the auto fields', () => {
  const p = project();
  const res = decide({ cwd: p.dir, sessionId: 's1', commit: p.fix, decision: 'confirmed' });
  assert.equal(res.ok, true, res.error);
  const [d] = readDecisions(p.dir);
  for (const k of ['auto', 'command', 'oldExit', 'fixExit']) assert.equal(k in d, false, k);
});
