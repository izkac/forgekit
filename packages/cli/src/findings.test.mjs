import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addFinding, KINDS } from './findings.mjs';

const FINDINGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'findings-cli.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function makeProject() {
  const cwd = tmp('forge-finding-');
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'phase-1',
      openspecChange: 'phase-1',
      phase: 'verify',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  return cwd;
}

function run(cwd, args) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('finding-fleet-'), 's') };
  try {
    const stdout = execFileSync(process.execPath, [FINDINGS, ...args], { cwd, env });
    const text = stdout.toString();
    try {
      return { status: 0, out: JSON.parse(text), text };
    } catch {
      return { status: 0, out: null, text };
    }
  } catch (err) {
    return { status: err.status, out: null, text: String(err.stdout), stderr: String(err.stderr) };
  }
}

test('a finding lands in a durable ledger with the session that raised it', () => {
  // "A finding either gets a home the day it is written, or it is not a
  // finding — it is a note." Three analysis reports in a row carried the same
  // unactioned items because nothing converted a line into tracked work.
  const cwd = makeProject();
  const { status, out } = run(cwd, [
    'add',
    'smoke suite pinned --workers=1 in 6/6 changes; the shared-state race is never fixed',
    '--kind',
    'bug',
    '--severity',
    'major',
  ]);

  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.match(out.id, /^F\d+$/);

  const ledger = path.join(cwd, '.forge', 'findings.jsonl');
  const [entry] = fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(entry.status, 'open');
  assert.equal(entry.sessionId, 's1');
  assert.match(entry.text, /workers=1/);
});

test('a finding can name the change that will carry it', () => {
  const cwd = makeProject();
  const { out } = run(cwd, [
    'add',
    'grouping.ts D1 extraction',
    '--kind',
    'bug',
    '--severity',
    'major',
    '--change',
    'fix-grouping-d1',
  ]);
  assert.equal(out.change, 'fix-grouping-d1');
  // The command tells you how to open that change rather than creating it
  // behind your back.
  assert.match(out.next, /forge change new fix-grouping-d1/);
});

test('list shows open findings and resolve closes one by id', () => {
  const cwd = makeProject();
  const first = run(cwd, [
    'add',
    'server suite baseline is 1-4 varying failures',
    '--kind',
    'bug',
    '--severity',
    'major',
  ]);
  run(cwd, ['add', 'untick 6.2 in the archived tasks.md', '--kind', 'bug', '--severity', 'major']);

  const open = run(cwd, ['list', '--json']);
  assert.equal(open.out.open.length, 2);

  const resolved = run(cwd, ['resolve', first.out.id, '--note', 'quarantined the flaky names']);
  assert.equal(resolved.status, 0);
  assert.equal(resolved.out.status, 'resolved');

  const after = run(cwd, ['list', '--json']);
  assert.equal(after.out.open.length, 1);
  assert.equal(after.out.resolved.length, 1);
  assert.match(after.out.resolved[0].note, /quarantined/);
});

test('list defaults to open bugs and can show all finding kinds', () => {
  const cwd = makeProject();
  run(cwd, ['add', 'broken pointer handling', '--kind', 'bug', '--severity', 'major']);
  run(cwd, ['add', 'consolidate session parser', '--kind', 'debt', '--severity', 'minor']);
  run(cwd, ['add', 'try a compact dashboard', '--kind', 'idea', '--severity', 'note']);

  const defaultList = run(cwd, ['list']);
  assert.match(defaultList.text, /bug/);
  assert.doesNotMatch(defaultList.text, /consolidate session parser/);
  assert.doesNotMatch(defaultList.text, /try a compact dashboard/);
  assert.match(defaultList.text, /2 open non-bug findings hidden.*--all-kinds/);

  const allKinds = run(cwd, ['list', '--all-kinds']);
  assert.match(allKinds.text, /debt/);
  assert.match(allKinds.text, /idea/);
  assert.doesNotMatch(allKinds.text, /hidden/);

  const json = run(cwd, ['list', '--json', '--all-kinds']);
  assert.deepEqual(
    json.out.open.map((entry) => entry.kind),
    ['bug', 'debt', 'idea'],
  );
});

test('a resolution note can be corrected, and the superseded text is kept', () => {
  // F42. Refusing to amend is why F52 exists: a whole second finding filed
  // purely to carry a correction the first one would not accept.
  const cwd = makeProject();
  const { out } = run(cwd, [
    'add',
    'the keep rule reads the wrong field',
    '--kind',
    'bug',
    '--severity',
    'major',
  ]);

  run(cwd, ['resolve', out.id, '--note', 'fixed by dropping the conjunct']);
  const amended = run(cwd, ['resolve', out.id, '--note', 'CORRECTION: dropping it broke a pin']);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.out.note, /CORRECTION/);
  assert.deepEqual(amended.out.noteHistory, ['fixed by dropping the conjunct']);
  assert.equal(amended.out.status, 'resolved', 'amending a note does not reopen the finding');
  assert.ok(amended.out.amendedAt, 'the amendment is dated');

  // resolvedAt records when it was resolved, which was the first call — an
  // amendment that moved it would misdate the finding to hide its own edit.
  const first = run(cwd, ['list', '--json', '--all']).out.resolved.at(-1);
  assert.equal(first.resolvedAt, amended.out.resolvedAt);
  assert.notEqual(amended.out.amendedAt, undefined);

  // A second correction stacks rather than replacing the first supersession.
  const again = run(cwd, ['resolve', out.id, '--note', 'third pass']);
  assert.deepEqual(again.out.noteHistory, [
    'fixed by dropping the conjunct',
    'CORRECTION: dropping it broke a pin',
  ]);

  // But a bare re-resolve still refuses: nothing to add, and answering "fine"
  // to a no-op is how the silent discard started.
  const bare = run(cwd, ['resolve', out.id]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /already resolved/);
  assert.match(bare.stderr, /--note/, 'and the refusal names the way to correct it');
});

test('resolving an unknown id fails loudly instead of silently succeeding', () => {
  const cwd = makeProject();
  const { status, stderr } = run(cwd, ['resolve', 'F999']);
  assert.equal(status, 1);
  assert.match(stderr, /F999/);
});

test('add refuses an empty finding', () => {
  const cwd = makeProject();
  const { status, stderr } = run(cwd, ['add', '   ']);
  assert.equal(status, 1);
  assert.match(stderr, /text/i);
});

test('findings work without an active session', () => {
  // Reports are often written between sessions; that must not block filing.
  const cwd = tmp('forge-finding-nosession-');
  fs.mkdirSync(path.join(cwd, '.forge'), { recursive: true });
  const { status, out } = run(cwd, [
    'add',
    'pace auto never selects brisk or lite',
    '--kind',
    'bug',
    '--severity',
    'major',
  ]);
  assert.equal(status, 0);
  assert.equal(out.sessionId, null);
});

test('forge status headlines open bugs and groups open findings by kind', () => {
  const cwd = makeProject();
  run(cwd, ['add', 'e2e parallel race unfixed', '--kind', 'bug', '--severity', 'major']);
  const resolvedBug = run(cwd, ['add', 'resolved bug', '--kind', 'bug', '--severity', 'minor']);
  run(cwd, ['resolve', resolvedBug.out.id, '--note', 'fixed']);
  run(cwd, ['add', 'pay down parser duplication', '--kind', 'debt', '--severity', 'minor']);
  run(cwd, ['add', 'record the compatibility choice', '--kind', 'tradeoff', '--severity', 'note']);
  run(cwd, ['add', 'try a compact dashboard', '--kind', 'idea', '--severity', 'note']);
  run(cwd, ['add', 'make the handoff checklist explicit', '--kind', 'process', '--severity', 'minor']);
  fs.appendFileSync(
    path.join(cwd, '.forge', 'findings.jsonl'),
    `${JSON.stringify({ id: 'F999', status: 'open', severity: 'major', text: 'legacy finding' })}\n`,
    'utf8',
  );

  const statusScript = path.join(path.dirname(FINDINGS), 'session-status.mjs');
  const stdout = execFileSync(process.execPath, [statusScript], {
    cwd,
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('finding-fleet-'), 's') },
  }).toString();
  const status = JSON.parse(stdout);
  assert.equal(status.openFindings.count, 1);
  assert.deepEqual(status.openFindings.byKind, {
    bug: 1,
    debt: 1,
    tradeoff: 1,
    idea: 1,
    process: 1,
  });
  assert.match(status.openFindings.latest[0].text, /parallel race/);
});

test('addFinding requires a kind from the five allowed values', () => {
  const forgeDir = path.join(tmp('forge-finding-library-'), '.forge');

  assert.deepEqual(KINDS, ['bug', 'debt', 'tradeoff', 'idea', 'process']);
  assert.throws(
    () => addFinding({ forgeDir, text: 'missing kind', severity: 'major' }),
    /bug.*debt.*tradeoff.*idea.*process/,
  );
});

test('addFinding requires severity', () => {
  const forgeDir = path.join(tmp('forge-finding-library-'), '.forge');

  assert.throws(
    () => addFinding({ forgeDir, text: 'missing severity', kind: 'bug' }),
    /severity/i,
  );
});

test('addFinding stores valid kind and severity', () => {
  const forgeDir = path.join(tmp('forge-finding-library-'), '.forge');

  const entry = addFinding({
    forgeDir,
    text: 'document the decision',
    kind: 'tradeoff',
    severity: 'minor',
  });

  assert.equal(entry.kind, 'tradeoff');
  assert.equal(entry.severity, 'minor');
});

test('addFinding refuses unknown kind and severity', () => {
  const forgeDir = path.join(tmp('forge-finding-library-'), '.forge');

  assert.throws(
    () => addFinding({ forgeDir, text: 'unknown kind', kind: 'unknown', severity: 'major' }),
    /unknown kind/i,
  );
  assert.throws(
    () => addFinding({ forgeDir, text: 'unknown severity', kind: 'bug', severity: 'urgent' }),
    /unknown severity/i,
  );
});
