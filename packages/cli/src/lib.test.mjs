import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultSession, findRepoRoot, sessionAgeDays } from './lib.mjs';

const SESSION_STATUS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'session-status.mjs',
);

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

test('sessionAgeDays reads createdAt, then startedAt, then updatedAt', () => {
  const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

  assert.ok(Math.abs(sessionAgeDays({ createdAt: days(3) }) - 3) < 0.01);
  // Hand-written / legacy records carry startedAt (a bare date) instead.
  assert.ok(Math.abs(sessionAgeDays({ startedAt: days(5).slice(0, 10) }) - 5) < 1.01);
  assert.ok(Math.abs(sessionAgeDays({ updatedAt: days(2) }) - 2) < 0.01);
  // createdAt wins when several are present.
  assert.ok(
    Math.abs(sessionAgeDays({ createdAt: days(9), startedAt: days(1), updatedAt: days(1) }) - 9) <
      0.01,
  );
});

test('sessionAgeDays treats an undatable session as infinitely old, not age 0', () => {
  // Regression: `new Date(undefined)` → NaN, and `NaN > RETENTION_DAYS` is
  // false, so a session record without a date was never "too old" and
  // survived every cleanup run forever.
  assert.equal(sessionAgeDays({ phase: 'implement' }), Infinity);
  assert.equal(sessionAgeDays({ createdAt: 'not-a-date' }), Infinity);
  assert.equal(sessionAgeDays({}), Infinity);
});

test('forge cleanup removes an undatable abandoned session', () => {
  const root = tmp('forge-cleanup-');
  const sessionDir = path.join(root, '.forge', 'sessions', 'legacy');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    // No date of any kind — the shape that lingered in volo, minus the
    // startedAt that now gives such records a real age.
    `${JSON.stringify({ slug: 'legacy', phase: 'implement' })}\n`,
    'utf8',
  );

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  const out = execFileSync(process.execPath, [cleanup], {
    cwd: root,
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-fleet-'), 's') },
  }).toString();

  assert.match(out, /"reason": "retention"/);
  assert.equal(fs.existsSync(sessionDir), false);
});

test('findRepoRoot walks up to the nearest .forge, then .git, then falls back', () => {
  const root = tmp('forge-root-');
  const nested = path.join(root, 'crates', 'helm-vfs', 'src');
  fs.mkdirSync(nested, { recursive: true });

  // No markers anywhere: the start dir is the root.
  assert.equal(findRepoRoot(nested), nested);

  // .git alone marks the project.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  assert.equal(findRepoRoot(nested), root);

  // .forge wins over .git when both are present but at different depths:
  // a nested checkout with its own session is its own project.
  const inner = path.join(root, 'crates');
  fs.mkdirSync(path.join(inner, '.forge'), { recursive: true });
  assert.equal(findRepoRoot(nested), inner);
  assert.equal(findRepoRoot(root), root);
});

test('forge status finds the session from a subdirectory of the project', () => {
  const root = tmp('forge-subdir-');
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
      phase: 'implement',
      planType: 'specs',
      openspecChange: 'my-change',
      tasksTotal: 3,
      tasksComplete: 1,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  const nested = path.join(root, 'crates', 'helm-vfs');
  fs.mkdirSync(nested, { recursive: true });

  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-subdir-fleet-'), 's') };
  const out = execFileSync(process.execPath, [SESSION_STATUS], { cwd: nested, env }).toString();
  const status = JSON.parse(out);

  assert.equal(status.status, 'ok');
  assert.equal(status.sessionId, 's1');
  // Paths stay relative to the project root, not to the working directory.
  assert.equal(status.sessionPath, '.forge/sessions/s1');

  // ...and through the bin, which re-roots the child process, so writes land
  // in the project's .forge rather than creating a second tree in the subdir.
  const FORGE_BIN = path.join(path.dirname(SESSION_STATUS), '..', 'bin', 'forge.mjs');
  execFileSync(process.execPath, [FORGE_BIN, 'phase', 'brainstorm'], { cwd: nested, env });
  const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(saved.phase, 'brainstorm');
  assert.equal(fs.existsSync(path.join(nested, '.forge')), false);
});

test('defaultSession declares the host binding and phase history fields', () => {
  // Declared here with every other session field rather than sprung into
  // existence by the first command that writes one: `bindHost` replaces the
  // null, and each phase transition appends to the array.
  const session = defaultSession('20260101T000000Z-telemetry-abc123', 'telemetry');
  assert.equal(session.host, null);
  assert.deepEqual(session.phaseHistory, []);
});

const SRC_DIR = path.dirname(SESSION_STATUS);
const FORGE_BIN = path.join(SRC_DIR, '..', 'bin', 'forge.mjs');

/**
 * Run a forge command in a scratch project root, with a scratch fleet dir and
 * no inherited host id — these tests may themselves run inside a host session.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {string} stdout
 */
function runForge(root, args, env = {}) {
  const base = {
    ...process.env,
    FORGEKIT_FLEET_DIR: path.join(tmp('forge-new-fleet-'), 's'),
  };
  delete base.CLAUDE_CODE_SESSION_ID;
  return execFileSync(process.execPath, [FORGE_BIN, ...args], {
    cwd: root,
    env: { ...base, ...env },
  }).toString();
}

/** @param {string} sessionDir */
function readSession(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
}

test('forge new binds the session to the host session that created it', () => {
  // Binding at creation is what makes it work mid-conversation: the host
  // session is already running, and no hook had to be installed for it.
  const root = tmp('forge-new-host-');
  const out = runForge(root, ['new', 'telemetry-probe'], { CLAUDE_CODE_SESSION_ID: 'host-new' });
  const session = readSession(JSON.parse(out).dir);

  assert.equal(session.host.agent, 'claude-code');
  assert.deepEqual(session.host.sessionIds, ['host-new']);
});

test('forge new outside any host session succeeds, silently, and stays unbound', () => {
  // Cursor, Codex and a plain shell all land here. Creation must not depend on
  // a host being present, and must not warn about it — a warning on every
  // command in those editors would be trained away within a day.
  const root = tmp('forge-new-nohost-');
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-new-fleet-'), 's') };
  delete env.CLAUDE_CODE_SESSION_ID;

  const res = spawnSync(process.execPath, [FORGE_BIN, 'new', 'telemetry-probe'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /bind|host/i);

  const session = readSession(JSON.parse(res.stdout).dir);
  assert.equal(session.host.agent, 'unknown');
  assert.deepEqual(session.host.sessionIds, []);
  assert.equal(session.host.boundAt, undefined, 'nothing was bound, so nothing to timestamp');
});

test('forge new seeds phaseHistory with the triage phase it starts in', () => {
  // phaseHistory is the join key telemetry attributes host requests by, so it
  // has to cover the whole session: without a first row at createdAt, every
  // request before the first `forge phase` falls into a hole.
  const root = tmp('forge-new-history-');
  const session = readSession(JSON.parse(runForge(root, ['new', 'telemetry-probe'])).dir);

  assert.deepEqual(session.phaseHistory, [{ phase: 'triage', at: session.createdAt }]);
});

test('forge new then forge phase triage records one triage row, not two', () => {
  const root = tmp('forge-new-history-idem-');
  const dir = JSON.parse(runForge(root, ['new', 'telemetry-probe'])).dir;
  const createdAt = readSession(dir).createdAt;

  runForge(root, ['phase', 'triage']);

  // The seeded row survives: re-entering the phase is not a transition, and
  // the timeline still starts exactly where the session does.
  assert.deepEqual(readSession(dir).phaseHistory, [{ phase: 'triage', at: createdAt }]);
});
