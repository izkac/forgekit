import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_PHASES,
  drainInbox,
  entryFile,
  flushPendingSessions,
  isTerminalPhase,
  listFleet,
  LIVE_WINDOW_MS,
  liveOverlaps,
  peekInbox,
  queueMessage,
  registerSession,
  sanitizePath,
  syncProjectSessions,
  touchSession,
  unregisterSession,
  watchEntries,
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

test('listFleet reconciles a stale entry against session.json on disk', () => {
  // Regression: the registry is a cache, not a source of truth. A session
  // whose phase advanced without a mirroring write (older CLI, a crash, a
  // hand-edited record) showed its first-registered phase forever — helm's
  // phase-0 sat at `brainstorm` in `forge fleet list` after reaching `done`.
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-reconcile-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's5');

  registerSession(project, makeSession('s5', { phase: 'brainstorm', tasksComplete: 0 }));
  // Disk moves on without the registry.
  const later = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify(
      makeSession('s5', {
        phase: 'done',
        tasksTotal: 20,
        tasksComplete: 20,
        openspecChange: 'phase-0',
        updatedAt: later,
      }),
    )}\n`,
    'utf8',
  );

  const [entry] = listFleet();
  assert.equal(entry.phase, 'done');
  assert.equal(entry.tasksComplete, 20);
  assert.equal(entry.tasksTotal, 20);
  assert.equal(entry.openspecChange, 'phase-0');
  assert.equal(entry.updatedAt, later);
  // Reconciliation is persisted, so the next read is already correct.
  assert.equal(JSON.parse(fs.readFileSync(entryFile(project, 's5'), 'utf8')).phase, 'done');
  // lastSeen is a heartbeat, not a session field — reconciling must not forge one.
  assert.ok(entry.lastSeen <= new Date().toISOString());
});

test('listFleet heals progress from tasks.md when session cache is stale', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-tasksmd-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's6');
  const changeDir = path.join(project, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] 1.1\n- [x] 1.2\n- [ ] 1.3\n', 'utf8');

  const session = makeSession('s6', { tasksTotal: 46, tasksComplete: 0 });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  registerSession(project, session);

  const [entry] = listFleet();
  assert.equal(entry.tasksComplete, 2);
  assert.equal(entry.tasksTotal, 3);
  const disk = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(disk.tasksComplete, 2);
  assert.equal(disk.tasksTotal, 3);
});

test('listFleet keeps registry-only fields when session.json is unreadable', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-unreadable-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's6');
  registerSession(project, makeSession('s6', { phase: 'verify' }));
  fs.writeFileSync(path.join(sessionDir, 'session.json'), '{ not json', 'utf8');

  const [entry] = listFleet();
  assert.equal(entry.phase, 'verify');
  assert.equal(entry.missing, false);
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

test('a skipped session is over: watch hides it and it is not a live overlap', () => {
  // Both call sites tested `phase !== 'done'` alone, so a session parked at
  // `skipped` rendered in the *live* watch view forever and counted as a second
  // agent editing the same working tree. Observed on two real sessions whose
  // work was complete (43/43 and 46/46 tasks) and which had been stamped
  // `skipped` rather than `done`.
  //
  // Every phase is derived from the module's own set rather than restated, so a
  // phase added to TERMINAL_PHASES is exercised here instead of silently
  // skipped — the same tripwire shape `review-verdict.test.mjs` uses.
  assert.deepEqual([...TERMINAL_PHASES].sort(), ['done', 'skipped']);
  for (const phase of TERMINAL_PHASES) assert.equal(isTerminalPhase(phase), true, phase);
  for (const phase of ['triage', 'brainstorm', 'plan', 'implement', 'verify', 'review', 'finish']) {
    assert.equal(isTerminalPhase(phase), false, phase);
  }
  // Absent is not terminal: an unreadable or half-written entry is a session
  // that may still be running, and hiding it is the direction that loses work.
  assert.equal(isTerminalPhase(undefined), false);
  assert.equal(isTerminalPhase(null), false);

  const rows = [
    { sessionId: 'live', phase: 'implement', missing: false },
    { sessionId: 'finished', phase: 'done', missing: false },
    { sessionId: 'parked', phase: 'skipped', missing: false },
    { sessionId: 'gone', phase: 'implement', missing: true },
  ];
  assert.deepEqual(
    watchEntries(rows).map((e) => e.sessionId),
    ['live'],
    'watch shows only sessions still under way',
  );
  assert.deepEqual(
    watchEntries(rows, true).map((e) => e.sessionId),
    rows.map((e) => e.sessionId),
    '--all shows every registered session, unfiltered',
  );

  // And the same rule at the other call site, through the real registry.
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-skip-'), 'sessions');
  const project = tmp('fleet-proj-');
  for (const id of ['me', 'peer', 'parked']) makeProject(project, id);
  registerSession(project, makeSession('me'));
  registerSession(project, makeSession('peer'));
  registerSession(project, makeSession('parked', { phase: 'skipped' }));
  assert.deepEqual(
    liveOverlaps(project, 'me').map((e) => e.sessionId),
    ['peer'],
    'a skipped session is not another agent in the working tree',
  );
});

test('a session that cannot be registered says so instead of vanishing', () => {
  // The handler here used to be an empty catch. Measured consequence: a change
  // in another project ran to `done` at 35/35 tasks having never once appeared
  // in `forge fleet`, and there was nothing on disk or on stderr to explain it —
  // an unregistered session is indistinguishable from one that never existed.
  // Registration stays best-effort (it must never cost a transition); what it
  // may not be is silent.
  const blocked = path.join(tmp('fleet-blocked-'), 'not-a-dir');
  fs.writeFileSync(blocked, 'this is a file, so mkdir of a child must fail\n', 'utf8');
  process.env.FORGEKIT_FLEET_DIR = path.join(blocked, 'sessions');
  const project = tmp('fleet-proj-');
  makeProject(project, 's1');

  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    registerSession(project, makeSession('s1'));
  } finally {
    process.stderr.write = original;
  }

  assert.match(captured, /could not register this session with the fleet registry/);
  assert.match(captured, /forge fleet/, 'the warning names the surface the session is missing from');
  assert.match(captured, /ENOTDIR|EEXIST|ENOENT/, 'and carries the underlying cause');
});

test('permission-denied register writes fleet-pending.json and names Cursor sandbox recovery', () => {
  const fleetRoot = tmp('fleet-ro-');
  fs.chmodSync(fleetRoot, 0o555);
  process.env.FORGEKIT_FLEET_DIR = path.join(fleetRoot, 'sessions');
  process.env.CURSOR_SANDBOX = 'native';
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's-pending');
  const session = makeSession('s-pending');

  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    registerSession(project, session);
  } finally {
    process.stderr.write = original;
    delete process.env.CURSOR_SANDBOX;
    fs.chmodSync(fleetRoot, 0o755);
  }

  const pending = path.join(sessionDir, 'fleet-pending.json');
  assert.equal(fs.existsSync(pending), true, 'pending stamp under the session dir');
  const body = JSON.parse(fs.readFileSync(pending, 'utf8'));
  assert.equal(body.sessionId, 's-pending');
  assert.match(captured, /could not register this session with the fleet registry/);
  assert.match(captured, /required_permissions|unrestricted|forge fleet sync/i);
  assert.match(captured, /CURSOR_SANDBOX|sandbox/i);
});

test('successful register clears fleet-pending.json', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-clear-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's-clear');
  fs.writeFileSync(
    path.join(sessionDir, 'fleet-pending.json'),
    `${JSON.stringify({ sessionId: 's-clear', reason: 'prior', at: new Date().toISOString() })}\n`,
    'utf8',
  );
  registerSession(project, makeSession('s-clear'));
  assert.equal(fs.existsSync(path.join(sessionDir, 'fleet-pending.json')), false);
  assert.equal(fs.existsSync(entryFile(project, 's-clear')), true);
});

test('flushPendingSessions registers a pending session when the registry is writable', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-flush-'), 'sessions');
  const project = tmp('fleet-proj-');
  const sessionDir = makeProject(project, 's-flush');
  const session = makeSession('s-flush');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(sessionDir, 'fleet-pending.json'),
    `${JSON.stringify({ sessionId: 's-flush', reason: 'EACCES', at: new Date().toISOString() })}\n`,
    'utf8',
  );
  const result = flushPendingSessions(project);
  assert.equal(result.attempted, 1);
  assert.equal(result.registered, 1);
  assert.equal(result.failed, 0);
  assert.equal(fs.existsSync(path.join(sessionDir, 'fleet-pending.json')), false);
  assert.equal(fs.existsSync(entryFile(project, 's-flush')), true);
});

test('syncProjectSessions re-registers every session.json in the project', () => {
  process.env.FORGEKIT_FLEET_DIR = path.join(tmp('fleet-sync-'), 'sessions');
  const project = tmp('fleet-proj-');
  const a = makeProject(project, 's-a');
  const b = makeProject(project, 's-b');
  fs.writeFileSync(path.join(a, 'session.json'), `${JSON.stringify(makeSession('s-a'))}\n`, 'utf8');
  fs.writeFileSync(path.join(b, 'session.json'), `${JSON.stringify(makeSession('s-b'))}\n`, 'utf8');
  const result = syncProjectSessions(project);
  assert.equal(result.total, 2);
  assert.equal(result.registered, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.pending, 0);
  assert.equal(listFleet().length, 2);
});

test('registerSession keeps scratch projects out of the default registry', () => {
  // F32. The unit suite spawns real `forge` processes against fixture projects
  // under os.tmpdir(), and the only thing keeping those out of the operator's
  // registry was `FORGEKIT_FLEET_DIR` being set by scripts/run-tests.mjs.
  // Running a suite file directly with `node --test` — which is what every
  // Forge tier-2 command instructs — bypassed it. Measured on the author's
  // machine before the fix: **8572** scratch entries against 10 real ones, so
  // `forge fleet report` was aggregating almost entirely dead /tmp paths.
  //
  // The guard cannot live in the harness, because the harness is the thing
  // being bypassed. This case therefore runs with `FORGEKIT_FLEET_DIR` unset —
  // the unprotected configuration — and redirects HOME instead, so the default
  // registry resolves somewhere disposable.
  const fakeHome = tmp('forge-fleet-home-');
  const scratchProject = tmp('forge-scratch-project-');
  const prevFleet = process.env.FORGEKIT_FLEET_DIR;
  const prevHome = process.env.HOME;
  delete process.env.FORGEKIT_FLEET_DIR;
  process.env.HOME = fakeHome;
  try {
    const registry = path.join(fakeHome, '.forgekit', 'fleet', 'sessions');
    registerSession(scratchProject, makeSession('sess-scratch'));
    assert.equal(fs.existsSync(registry), false, 'a scratch project must not create the registry');

    // A real project root still registers — the guard must not disable the
    // feature it protects. `registerSession` never stats the path, so this need
    // not exist; it only has to be somewhere a person keeps code, and it must
    // not be derived from HOME, which this case has pointed at a temp dir.
    const realProject = path.join(path.sep, 'home', 'demo-user', 'Projects', 'demo-project');
    registerSession(realProject, makeSession('sess-real'));
    assert.equal(fs.existsSync(entryFile(realProject, 'sess-real')), true);
    assert.deepEqual(
      fs.readdirSync(registry).filter((f) => f.includes('scratch')),
      [],
    );
  } finally {
    if (prevFleet === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prevFleet;
    process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('a real project whose path merely contains the temp dir name is registered', () => {
  // The guard compares path *segments*, not substrings. A naive
  // `projectRoot.includes(os.tmpdir())` also swallows `/home/me/tmp-project`
  // and `/home/me/tmpfoo/app`, silently dropping real work out of the fleet
  // report — a guard against pollution that quietly loses data instead. Added
  // after a mutant survived: the comment claimed this and no case proved it.
  const fakeHome = tmp('forge-fleet-home-substr-');
  const prevFleet = process.env.FORGEKIT_FLEET_DIR;
  const prevHome = process.env.HOME;
  delete process.env.FORGEKIT_FLEET_DIR;
  process.env.HOME = fakeHome;
  try {
    for (const [i, root] of [
      path.join(path.sep, 'home', 'demo-user', `${path.basename(tmpdir())}-project`),
      path.join(path.sep, 'home', 'demo-user', `${path.basename(tmpdir())}foo`, 'app'),
    ].entries()) {
      registerSession(root, makeSession(`sess-substr-${i}`));
      assert.equal(
        fs.existsSync(entryFile(root, `sess-substr-${i}`)),
        true,
        `${root} is a real project and must be registered`,
      );
    }
  } finally {
    if (prevFleet === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prevFleet;
    process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('an explicitly redirected registry may hold scratch projects', () => {
  // The fleet suite's own fixtures are temp projects, and they must keep
  // working: pointing FORGEKIT_FLEET_DIR at a directory is a statement that the
  // caller owns it. Without this the guard would make the registry untestable.
  const registry = tmp('forge-fleet-explicit-');
  const scratchProject = tmp('forge-scratch-allowed-');
  const prev = process.env.FORGEKIT_FLEET_DIR;
  process.env.FORGEKIT_FLEET_DIR = registry;
  try {
    registerSession(scratchProject, makeSession('sess-allowed'));
    assert.equal(fs.existsSync(entryFile(scratchProject, 'sess-allowed')), true);
  } finally {
    if (prev === undefined) delete process.env.FORGEKIT_FLEET_DIR;
    else process.env.FORGEKIT_FLEET_DIR = prev;
    fs.rmSync(registry, { recursive: true, force: true });
  }
});
