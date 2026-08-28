import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { taskGateChecksHash } from './integrity.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs');
const FORGE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forge.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function fleetEnv() {
  return { FORGEKIT_FLEET_DIR: path.join(tmp('gate-fleet-'), 's') };
}

function run(cwd, args) {
  return execFileSync(process.execPath, [GATE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...fleetEnv() },
  });
}

/** Like run(), but tolerates a non-zero exit. */
function runAllowFail(cwd, args) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...fleetEnv() },
  });
}

/** .forge fixture with an active session tracking a specs change. */
function makeFixture(root, { gatesEnabled = true } = {}) {
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'fixture', planType: 'specs', openspecChange: 'my-change' })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  if (gatesEnabled) {
    fs.writeFileSync(
      path.join(root, '.forge', 'config.json'),
      `${JSON.stringify({ gates: { enabled: true } }, null, 2)}\n`,
      'utf8',
    );
  }
  return { sessionDir, changeDir };
}

const WALL_MESSAGE = 'gates are not enabled (.forge/config.json → gates.enabled)\n';

test('gate wall: disabled project — each subcommand exits 1 with exact message, writes nothing', () => {
  for (const sub of ['init', 'check', 'status']) {
    const root = tmp('gate-wall-');
    makeFixture(root, { gatesEnabled: false });
    const before = fs.readdirSync(path.join(root, 'specs', 'changes', 'my-change'));
    assert.deepEqual(before, [], 'fixture starts with an empty change dir');

    const r = runAllowFail(root, [sub]);
    assert.equal(r.status, 1, `forge gate ${sub} must exit 1 when gates are disabled`);
    assert.equal(r.stdout, '', `forge gate ${sub} must write nothing to stdout while disabled`);
    assert.equal(r.stderr, WALL_MESSAGE, `forge gate ${sub} must print exactly one line`);

    const after = fs.readdirSync(path.join(root, 'specs', 'changes', 'my-change'));
    assert.deepEqual(after, [], `forge gate ${sub} must write no files while disabled`);
  }
});

test('gate wall: no .forge/config.json at all is also treated as disabled', () => {
  const root = tmp('gate-wall-noconfig-');
  makeFixture(root, { gatesEnabled: false });
  assert.equal(fs.existsSync(path.join(root, '.forge', 'config.json')), false);
  const r = runAllowFail(root, ['status']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, WALL_MESSAGE);
});

/** tasks.md whose group headings deliberately vary id/title/punctuation. */
const TASKS_MD = [
  '# Tasks',
  '',
  '## 1. Stop hook template',
  '',
  '- [ ] 1.1 do a thing',
  '',
  '## 2. Gate CLI (opt-in)',
  '',
  '- [ ] 2.1 do another thing',
  '',
  '## 3) Third group, paren style',
  '',
  '- [ ] 3.1 do a third thing',
  '',
].join('\n');

test('gate init: scaffolds one entry per tasks.md group, derived from the fixture', () => {
  const root = tmp('gate-init-');
  const { changeDir } = makeFixture(root);
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), TASKS_MD, 'utf8');

  // Expected groups computed from the fixture body itself, not transcribed.
  const expectedGroups = [...TASKS_MD.matchAll(/^##\s+(\d+)[.)]\s*(.*)$/gm)].map((m) => ({
    id: m[1],
    title: m[2].trim(),
  }));
  assert.equal(expectedGroups.length, 3, 'fixture sanity: three group headings');

  const out = run(root, ['init']);
  assert.match(out, /Scaffolded/);

  const gatesFile = path.join(changeDir, 'gates.json');
  assert.equal(fs.existsSync(gatesFile), true);
  const doc = JSON.parse(fs.readFileSync(gatesFile, 'utf8'));
  assert.equal(doc.groups.length, expectedGroups.length);
  for (let i = 0; i < expectedGroups.length; i += 1) {
    assert.equal(doc.groups[i].id, expectedGroups[i].id);
    assert.equal(doc.groups[i].title, expectedGroups[i].title);
    assert.equal(doc.groups[i].check, '');
    assert.equal(doc.groups[i].expect, '');
    assert.equal(typeof doc.groups[i].timeoutMs, 'number');
    assert.ok(doc.groups[i].timeoutMs > 0);
  }
});

test('gate init: refuses to overwrite an existing gates.json', () => {
  const root = tmp('gate-init-noclobber-');
  const { changeDir } = makeFixture(root);
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), TASKS_MD, 'utf8');
  run(root, ['init']);

  const gatesFile = path.join(changeDir, 'gates.json');
  const before = fs.readFileSync(gatesFile, 'utf8');

  const r = runAllowFail(root, ['init']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gates\.json already exists/);
  assert.match(r.stderr, new RegExp(gatesFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'must print the path');

  const after = fs.readFileSync(gatesFile, 'utf8');
  assert.equal(after, before, 'refused overwrite must not touch the existing file');
});

/**
 * Recompute a group's checksHash straight from the fixture object — mirrors
 * the sha256(JSON.stringify(...)) approach `e2eStepsHash` uses in
 * integrity.mjs, scoped to one group's check+expect instead of a step array.
 * Never a number transcribed from the brief: this is the same formula the
 * production code applies, run here against the actual fixture data so a
 * wrong implementation (or a wrong test) shows up as a real mismatch.
 */
function computeChecksHash(group) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ check: group.check ?? '', expect: group.expect ?? '' }))
    .digest('hex');
}

/** node -e script that prints TOKEN then exits with CODE — portable (no
 * POSIX-only shell syntax; `shell: true` is cmd.exe on Windows). */
function nodeCmd(token, code) {
  return `node -e "console.log('${token}'); process.exit(${code})"`;
}

function writeGates(changeDir, groups) {
  fs.writeFileSync(path.join(changeDir, 'gates.json'), `${JSON.stringify({ groups }, null, 2)}\n`, 'utf8');
}

function readGateResults(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'gate-results.json'), 'utf8'));
}

test('gate check: passing check+expect writes a green results file with checksHash', () => {
  const root = tmp('gate-check-green-');
  const { changeDir, sessionDir } = makeFixture(root);
  const group = { id: '1', title: 'g1', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 };
  writeGates(changeDir, [group]);

  const out = run(root, ['check']);
  assert.match(out, /GREEN/);

  const results = readGateResults(sessionDir);
  assert.equal(results.groups.length, 1);
  const entry = results.groups[0];
  assert.equal(entry.id, '1');
  assert.equal(entry.ok, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.expectMatched, true);
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal(entry.checksHash, computeChecksHash(group), 'checksHash must match the group that was run');
  assert.equal(typeof results.ranAt, 'string');
});

test('gate check: recorded checksHash agrees with integrity.mjs taskGateChecksHash for the same group (hash-drift cross-check, no gate.mjs import)', () => {
  // Pins gate.mjs's groupChecksHash formula and integrity.mjs's
  // taskGateChecksHash formula to each other end-to-end, without ever
  // importing gate.mjs (a CLI entrypoint — see taskGateChecksHash's doc
  // comment in integrity.mjs for why that import is unsafe). The real
  // `forge gate check` CLI is spawned as a child process against a scratch
  // project; the checksHash it actually recorded is then compared against
  // taskGateChecksHash computed independently, in this process, off the
  // identical fixture group object. A drift between the two formulas would
  // show up here as a real mismatch, not a passed test that never exercised
  // gate.mjs's own hashing code path.
  const root = tmp('gate-hashdrift-');
  const { changeDir, sessionDir } = makeFixture(root);
  const group = { id: '1', title: 'g1', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 };
  writeGates(changeDir, [group]);

  const out = run(root, ['check']);
  assert.match(out, /GREEN/);

  const results = readGateResults(sessionDir);
  const recordedHash = results.groups[0].checksHash;
  assert.equal(
    recordedHash,
    taskGateChecksHash(group),
    'gate.mjs (groupChecksHash) and integrity.mjs (taskGateChecksHash) must agree on the same group',
  );
});

test('gate check: failing exit code is unmet even when output contains the expect token', () => {
  const root = tmp('gate-check-exitfail-');
  const { changeDir, sessionDir } = makeFixture(root);
  // Output DOES contain the expect token, but the process exits non-zero —
  // the discarded candidate (green-looking output) must not win.
  const group = { id: '1', title: 'g1', check: nodeCmd('OK-TOKEN', 1), expect: 'OK-TOKEN', timeoutMs: 15000 };
  writeGates(changeDir, [group]);

  const r = runAllowFail(root, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILED/);

  const results = readGateResults(sessionDir);
  const entry = results.groups[0];
  assert.equal(entry.ok, false, 'a non-zero exit must not be met regardless of output');
  assert.equal(entry.exitCode, 1);
  assert.equal(entry.expectMatched, null, 'expect is not evaluated when exit code already failed');
});

test('gate check: expect mismatch on exit 0 is unmet', () => {
  const root = tmp('gate-check-expectmiss-');
  const { changeDir, sessionDir } = makeFixture(root);
  const group = { id: '1', title: 'g1', check: nodeCmd('NOPE', 0), expect: 'OK-TOKEN', timeoutMs: 15000 };
  writeGates(changeDir, [group]);

  const r = runAllowFail(root, ['check']);
  assert.equal(r.status, 1);

  const results = readGateResults(sessionDir);
  const entry = results.groups[0];
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.expectMatched, false);
  assert.equal(entry.ok, false, 'exit 0 alone is not enough — expect must also match');
});

test('gate check: only groups with a non-empty check run; others are left out of results', () => {
  const root = tmp('gate-check-emptycheck-');
  const { changeDir, sessionDir } = makeFixture(root);
  writeGates(changeDir, [
    { id: '1', title: 'has no check yet', check: '', expect: '', timeoutMs: 15000 },
    { id: '2', title: 'g2', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
  ]);

  const out = run(root, ['check']);
  assert.match(out, /GREEN/);

  const results = readGateResults(sessionDir);
  assert.equal(results.groups.length, 1, 'the empty-check group must never be executed or recorded');
  assert.equal(results.groups[0].id, '2');
});

test('gate check --group merges into existing results; other groups are preserved', () => {
  const root = tmp('gate-check-merge-');
  const { changeDir, sessionDir } = makeFixture(root);
  writeGates(changeDir, [
    { id: '1', title: 'g1', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '2', title: 'g2', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
  ]);
  run(root, ['check']);
  const firstRun = readGateResults(sessionDir);
  assert.equal(firstRun.groups.length, 2);
  assert.ok(firstRun.groups.every((g) => g.ok === true));

  // Now break group 1 only, and re-check just that group.
  writeGates(changeDir, [
    { id: '1', title: 'g1', check: nodeCmd('OK-TOKEN', 1), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '2', title: 'g2', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
  ]);
  const r = runAllowFail(root, ['check', '--group', '1']);
  assert.equal(r.status, 1);

  const merged = readGateResults(sessionDir);
  assert.equal(merged.groups.length, 2, 'group 2 entry must be preserved even though it did not run this time');
  const g1 = merged.groups.find((g) => g.id === '1');
  const g2 = merged.groups.find((g) => g.id === '2');
  assert.equal(g1.ok, false, 'group 1 was re-run and now fails');
  assert.equal(g2.ok, true, 'group 2 entry is untouched from the first run');
  assert.equal(g2.durationMs, firstRun.groups.find((g) => g.id === '2').durationMs, 'byte-identical, not re-run');
});

test('gate status: met / unmet / stale / no-check / no-run, and edited check goes stale', () => {
  const root = tmp('gate-status-');
  const { changeDir, sessionDir } = makeFixture(root);
  writeGates(changeDir, [
    { id: '1', title: 'greens', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '2', title: 'reds', check: nodeCmd('OK-TOKEN', 1), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '3', title: 'never run', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '4', title: 'no check configured', check: '', expect: '', timeoutMs: 15000 },
  ]);
  runAllowFail(root, ['check', '--group', '1']);
  runAllowFail(root, ['check', '--group', '2']);

  const statusJson = JSON.parse(run(root, ['status', '--json']));
  const byId = Object.fromEntries(statusJson.groups.map((g) => [g.id, g.status]));
  assert.equal(byId['1'], 'met');
  assert.equal(byId['2'], 'unmet');
  assert.equal(byId['3'], 'no-run');
  assert.equal(byId['4'], 'no-check');

  // status must always exit 0 — informational only.
  const statusExit = runAllowFail(root, ['status']);
  assert.equal(statusExit.status, 0);

  // Editing group 1's check after its green run invalidates the recorded
  // evidence — the results file itself must still show the OLD hash (proving
  // this is a comparison against current gates.json, not a silent rewrite).
  const beforeEdit = readGateResults(sessionDir);
  const oldHash = beforeEdit.groups.find((g) => g.id === '1').checksHash;
  const editedGroup1 = { id: '1', title: 'greens', check: nodeCmd('OK-TOKEN-V2', 0), expect: 'OK-TOKEN', timeoutMs: 15000 };
  writeGates(changeDir, [
    editedGroup1,
    { id: '2', title: 'reds', check: nodeCmd('OK-TOKEN', 1), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '3', title: 'never run', check: nodeCmd('OK-TOKEN', 0), expect: 'OK-TOKEN', timeoutMs: 15000 },
    { id: '4', title: 'no check configured', check: '', expect: '', timeoutMs: 15000 },
  ]);

  const newHash = computeChecksHash(editedGroup1);
  assert.notEqual(newHash, oldHash, 'fixture sanity: editing the check must change the hash');

  const afterEdit = JSON.parse(run(root, ['status', '--json']));
  const byIdAfter = Object.fromEntries(afterEdit.groups.map((g) => [g.id, g.status]));
  assert.equal(byIdAfter['1'], 'stale', 'edited check must invalidate the old green evidence');

  const untouchedResults = readGateResults(sessionDir);
  assert.equal(
    untouchedResults.groups.find((g) => g.id === '1').checksHash,
    oldHash,
    'forge gate status must not rewrite gate-results.json — it only compares against it',
  );
});

test('forge gate is routed in bin/forge.mjs (disabled-wall message proves routing)', () => {
  const root = tmp('gate-routing-');
  makeFixture(root, { gatesEnabled: false });
  const r = spawnSync(process.execPath, [FORGE_BIN, 'gate', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...fleetEnv() },
  });
  assert.equal(r.status, 1, 'forge gate must reach gate.mjs, not "Unknown command"');
  assert.doesNotMatch(r.stderr, /Unknown command/, 'must be routed, not falling through to the unknown-command path');
  assert.equal(r.stderr, WALL_MESSAGE, 'gate.mjs itself must have run and hit its own opt-in wall');
});

test('forge --help lists the gate command', () => {
  const r = spawnSync(process.execPath, [FORGE_BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gate init\|check\|status/);
});

test('gate status: missing gates.json is informational, not an error', () => {
  const root = tmp('gate-status-missing-');
  makeFixture(root);
  const r = runAllowFail(root, ['status']);
  assert.equal(r.status, 0);
  const j = JSON.parse(run(root, ['status', '--json']));
  assert.equal(j.exists, false);
  assert.deepEqual(j.groups, []);
});
