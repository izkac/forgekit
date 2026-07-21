import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  drainInbox,
  entryFile,
  listFleet,
  LIVE_WINDOW_MS,
  liveOverlaps,
  peekInbox,
  queueMessage,
  registerSession,
  sanitizePath,
  touchSession,
  unregisterSession,
} from './lib/fleet.mjs';
import { saveSession } from './lib.mjs';

const FLEET_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(id, extra = {}) {
  const now = new Date().toISOString();
  return {
    id,
    slug: 'fixture',
    createdAt: now,
    updatedAt: now,
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'my-change',
    tasksTotal: 10,
    tasksComplete: 4,
    pace: 'auto',
    resolvedPace: 'standard',
    ...extra,
  };
}

/** Scratch project with a session dir so listFleet keeps the entry. */
function makeProject(root, sessionId) {
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

test('register / list / unregister roundtrip', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-reg-'), 'sessions');
  const project = tmp('fleet-proj-');
  makeProject(project, 's1');

  registerSession(project, makeSession('s1'));
  const entries = listFleet();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's1');
  assert.equal(entries[0].project, project);
  assert.equal(entries[0].projectName, path.basename(project));
  assert.equal(entries[0].phase, 'implement');
  assert.equal(entries[0].tasksTotal, 10);
  assert.equal(entries[0].tasksComplete, 4);
  assert.equal(entries[0].pace, 'standard');
  assert.equal(entries[0].missing, false);

  unregisterSession(project, 's1');
  assert.equal(listFleet().length, 0);
});

test('listFleet self-heals entries whose session dir is gone', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-heal-'), 'sessions');
  const project = tmp('fleet-proj-');
  registerSession(project, makeSession('gone')); // no session dir created
  assert.equal(listFleet().length, 0);
  assert.equal(fs.existsSync(entryFile(project, 'gone')), false);
});

test('saveSession mirrors into the fleet registry', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-mirror-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's2');

  saveSession(sessionDir, makeSession('s2', { phase: 'review' }));
  const entries = listFleet();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's2');
  assert.equal(entries[0].phase, 'review');
});

test('queue → peek → drain delivers each message exactly once', () => {
  const sessionDir = makeProject(tmp('fleet-proj-'), 's3');
  queueMessage(sessionDir, 'pause and report status');
  assert.equal(peekInbox(sessionDir).length, 1);

  const drained = drainInbox(sessionDir);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, 'pause and report status');
  assert.equal(drainInbox(sessionDir).length, 0);
  assert.equal(peekInbox(sessionDir).length, 0);
});

test('fleet CLI: send queues, list --json reports pending-capable entries', () => {
  const fleetDir = path.join(tmp('fleet-cli-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's4');
  const env = { ...process.env, FORGEKIT_FLEET_DIR: fleetDir };

  registerSessionIn(fleetDir, project, makeSession('s4'));

  const listOut = execFileSync(process.execPath, [FLEET_SCRIPT, 'list', '--json'], { env });
  const parsed = JSON.parse(listOut.toString());
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sessionId, 's4');

  execFileSync(process.execPath, [FLEET_SCRIPT, 'send', 's4', 'ship', 'it'], { env });
  const pending = peekInbox(sessionDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, 'ship it');
});

/** register via a temp override without clobbering this process's env-based dir */
function registerSessionIn(fleetDir, project, session) {
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = fleetDir;
  try {
    registerSession(project, session);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
  }
}

test('registerSession stamps lastSeen; touchSession refreshes it', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-hb-'), 'sessions');
  const project = tmp('fleet-proj-');
  makeProject(project, 's5');

  registerSession(project, makeSession('s5'));
  const before = listFleet()[0].lastSeen;
  assert.ok(before);

  const file = entryFile(project, 's5');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  entry.lastSeen = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(entry));

  touchSession(project, 's5');
  const after = listFleet()[0].lastSeen;
  assert.ok(after > '2000-01-01T00:00:00.000Z');
});

test('liveOverlaps flags only live sessions in the same project', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-ovl-'), 'sessions');
  const project = tmp('fleet-proj-');
  const other = tmp('fleet-proj2-');
  for (const id of ['me', 'peer', 'finished']) makeProject(project, id);
  makeProject(other, 'elsewhere');

  registerSession(project, makeSession('me'));
  registerSession(project, makeSession('peer'));
  registerSession(project, makeSession('finished', { phase: 'done' }));
  registerSession(other, makeSession('elsewhere'));

  const overlaps = liveOverlaps(project, 'me');
  assert.deepEqual(
    overlaps.map((e) => e.sessionId),
    ['peer'],
  );

  // Stale heartbeat falls outside the liveness window.
  assert.equal(liveOverlaps(project, 'me', Date.now() + LIVE_WINDOW_MS + 1000).length, 0);
});

test('sanitizePath matches Claude Code project-dir naming', () => {
  assert.equal(sanitizePath('S:\\Projects\\forgekit'), 'S--Projects-forgekit');
});
