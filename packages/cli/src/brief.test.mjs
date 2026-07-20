import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  briefPath,
  checkBrief,
  readBriefHash,
  specsHash,
  stampBrief,
} from './brief.mjs';

const SET_PHASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'set-phase.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/** Project with a specs-engine change dir containing proposal + tasks. */
function makeChange(root, change) {
  const changeDir = path.join(root, 'specs', 'changes', change);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Why\nBecause.\n', 'utf8');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '# Tasks\n- [ ] 1.1 do it\n', 'utf8');
  return changeDir;
}

function writeBrief(changeDir) {
  fs.writeFileSync(
    briefPath(changeDir),
    '<html><head><title>Brief</title></head><body><h1>TL;DR</h1></body></html>\n',
    'utf8',
  );
}

function makeSession(overrides = {}) {
  return {
    id: 's1',
    slug: 'fixture',
    planType: 'specs',
    openspecChange: 'my-change',
    ...overrides,
  };
}

test('specsHash changes when a spec file changes', () => {
  const changeDir = makeChange(tmp('brief-'), 'my-change');
  const before = specsHash(changeDir);
  fs.appendFileSync(path.join(changeDir, 'proposal.md'), 'More.\n');
  assert.notEqual(specsHash(changeDir), before);
});

test('stampBrief injects the marker once and restamp replaces it', () => {
  const changeDir = makeChange(tmp('brief-'), 'my-change');
  writeBrief(changeDir);
  const hash = stampBrief(changeDir);
  assert.equal(readBriefHash(briefPath(changeDir)), hash);

  fs.appendFileSync(path.join(changeDir, 'tasks.md'), '- [ ] 1.2 more\n');
  const hash2 = stampBrief(changeDir);
  assert.notEqual(hash2, hash);
  const html = fs.readFileSync(briefPath(changeDir), 'utf8');
  assert.equal(html.match(/forge-brief-specs-hash/g).length, 1);
});

test('stampBrief throws when brief.html is missing', () => {
  const changeDir = makeChange(tmp('brief-'), 'my-change');
  assert.throws(() => stampBrief(changeDir), /write the operator brief first/);
});

test('checkBrief lifecycle: missing → unstamped → fresh → stale', () => {
  const root = tmp('brief-');
  const changeDir = makeChange(root, 'my-change');
  const session = makeSession();

  assert.equal(checkBrief({ cwd: root, session }).reason, 'missing');

  writeBrief(changeDir);
  assert.equal(checkBrief({ cwd: root, session }).reason, 'unstamped');

  stampBrief(changeDir);
  const fresh = checkBrief({ cwd: root, session });
  assert.equal(fresh.reason, 'fresh');
  assert.equal(fresh.ok, true);

  fs.appendFileSync(path.join(changeDir, 'proposal.md'), 'Edited after stamp.\n');
  const stale = checkBrief({ cwd: root, session });
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.ok, false);
});

test('checkBrief not-applicable without a change or for direct/throwaway plans', () => {
  const root = tmp('brief-');
  assert.equal(
    checkBrief({ cwd: root, session: makeSession({ openspecChange: null }) }).reason,
    'not-applicable',
  );
  makeChange(root, 'my-change');
  assert.equal(
    checkBrief({ cwd: root, session: makeSession({ planType: 'direct' }) }).reason,
    'not-applicable',
  );
});

/** Full .forge fixture so set-phase.mjs can run as a child in `root`. */
function makePhaseFixture(root, overrides = {}) {
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 's1',
      slug: 'fixture',
      createdAt: now,
      updatedAt: now,
      phase: 'plan',
      planType: 'specs',
      openspecChange: 'my-change',
      forgeSkipped: false,
      tasksTotal: 0,
      tasksComplete: 0,
      ...overrides,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  return sessionDir;
}

function runSetPhase(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [SET_PHASE, ...args], {
      cwd,
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('brief-fleet-'), 's') },
    });
    return { status: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

test('phase implement hard-refuses without a fresh brief, passes with one', () => {
  const root = tmp('brief-gate-');
  const changeDir = makeChange(root, 'my-change');
  makePhaseFixture(root);

  const refused = runSetPhase(root, ['implement', '--tasks-total', '3']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /operator brief missing/);

  writeBrief(changeDir);
  stampBrief(changeDir);
  const ok = runSetPhase(root, ['implement', '--tasks-total', '3']);
  assert.equal(ok.status, 0);

  fs.appendFileSync(path.join(changeDir, 'tasks.md'), '- [ ] 1.9 late edit\n');
  const stale = runSetPhase(root, ['implement']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/);
});

test('phase implement --allow-incomplete records briefSkipped', () => {
  const root = tmp('brief-gate-');
  makeChange(root, 'my-change');
  const sessionDir = makePhaseFixture(root);

  const ok = runSetPhase(root, ['implement', '--allow-incomplete', 'operator waived brief']);
  assert.equal(ok.status, 0);
  const session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(session.briefSkipped, 'operator waived brief');
});

test('phase implement unaffected for sessions without a tracked change', () => {
  const root = tmp('brief-gate-');
  makePhaseFixture(root, { planType: null, openspecChange: null });
  const ok = runSetPhase(root, ['implement', '--tasks-total', '2']);
  assert.equal(ok.status, 0);
});
