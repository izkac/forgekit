import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultSession, findRepoRoot, sessionAgeDays, writeJson } from './lib.mjs';

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

test('forge new lists related open bugs for the slug without blocking', () => {
  const root = tmp('forge-new-related-');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.forge', 'findings.jsonl'),
    `${JSON.stringify({
      id: 'F1',
      text: 'parser drops empty flags',
      kind: 'bug',
      severity: 'major',
      status: 'open',
      change: 'fix-parser',
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  const env = {
    ...process.env,
    FORGEKIT_FLEET_DIR: path.join(tmp('forge-new-fleet-'), 's'),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CURSOR_TRACE_ID;
  const res = spawnSync(process.execPath, [FORGE_BIN, 'new', 'fix-parser'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.relatedFindings.length, 1);
  assert.equal(out.relatedFindings[0].id, 'F1');
  assert.match(res.stderr, /F1/);
  assert.ok(out.sessionId, 'session still created');
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

test('writeJson replaces the file rather than truncating it in place', () => {
  // `active.json` is now written on every phase transition, so a concurrent
  // reader hits it far more often than when these files were written once per
  // command. `writeFileSync` truncates and *then* writes: measured with two
  // concurrent writer processes, a plain write produced **62 torn reads in
  // 79**; the same probe over a rename produced 0. A torn read of `active.json`
  // costs real guards — `forge cleanup` loses the live-session check that stops
  // it deleting work in progress, and the SessionStart hook tells the next
  // agent there is no session at all.
  //
  // Asserted through the inode rather than by racing a writer, because a timing
  // test that passes on a fast machine and fails on a loaded one teaches
  // nothing. A rename installs a *new* file; an in-place write keeps the inode.
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'forge-writejson-'));
  const file = path.join(dir, 'active.json');

  writeJson(file, { sessionId: 'first' });
  const before = fs.statSync(file).ino;

  writeJson(file, { sessionId: 'second', padding: 'x'.repeat(4096) });
  const after = fs.statSync(file).ino;

  assert.notEqual(after, before, 'the destination must be replaced, not rewritten in place');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionId, 'second');
  // And no temp file left beside it, which would confuse anything globbing the dir.
  assert.deepEqual(fs.readdirSync(dir), ['active.json']);
});

test('cleanup will not age out a session with work in it', () => {
  // Reproduced by the final review: `(tooOld || isDone)` deleted a twenty-day
  // session sitting at `implement`, verify evidence and final review inside,
  // while keeping the *finished* session `active.json` named. `finish.md` runs
  // `forge cleanup` on the line after `forge phase done`.
  //
  // The line is not finished-versus-unfinished — retention exists to clear
  // abandoned sessions and those are unfinished by definition. It is whether
  // the directory holds anything but its own session.json.
  const root = tmp('forge-cleanup-work-');
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  const plant = (id, extra) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase: 'implement', createdAt: old, updatedAt: old })}\n`,
    );
    if (extra) fs.writeFileSync(path.join(dir, extra), 'work\n');
    return dir;
  };
  const withWork = plant('has-work', 'verify-evidence.md');
  // Scaffolding only — what `forge new` lays down and nobody has written to.
  // The first version of this rule counted `status.json` as work, so retention
  // could never clear an abandoned session at all.
  const shell = plant('empty-shell', null);
  fs.writeFileSync(path.join(shell, 'status.json'), '{}\n');
  for (const d of ['tasks', 'reviews', 'brainstorm']) fs.mkdirSync(path.join(shell, d));

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  execFileSync(process.execPath, [cleanup], {
    cwd: root,
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-fleet-'), 's') },
  });

  assert.equal(fs.existsSync(withWork), true, 'a session with work in it must survive its age');
  assert.equal(fs.existsSync(shell), false, 'an empty shell is scratch and still ages out');

  // A project-wide sweep of unfinished work is refused outright: the only thing
  // standing between it and the wrong session would be `active.json`, the
  // pointer this change exists because you cannot trust. Reproduced by the
  // review — a bare sweep deleted a 20-day live session and kept a 90-day
  // abandoned one, purely because the pointer named the abandoned one.
  const swept = spawnSync(process.execPath, [cleanup, '--include-unfinished'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-fleet-'), 's') },
  });
  assert.notEqual(swept.status, 0, 'a project-wide unfinished sweep must be refused');
  assert.match(swept.stderr, /Name the one you mean/);
  assert.equal(fs.existsSync(withWork), true, 'and it must not have deleted anything');

  // Named, it goes.
  execFileSync(process.execPath, [cleanup, '--include-unfinished', '--session', 'has-work'], {
    cwd: root,
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-fleet-'), 's') },
  });
  assert.equal(fs.existsSync(withWork), false, 'naming it is how you say you mean it');
});

test('cleanup retains unfinished plan session with live change dir (F48)', () => {
  // Plan-phase work lives under <plan.dir>/changes/, not the session dir.
  // An aged unfinished session with only scaffold files must survive bare
  // cleanup when openspecChange names a live change dir — and must still
  // yield to an explicit --include-unfinished --session. An archived-only
  // change does not protect.
  const root = tmp('forge-cleanup-plan-');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs' } })}\n`,
  );
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  const plantScaffold = (id, change) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({
        id,
        slug: id,
        phase: 'plan',
        planType: 'specs',
        openspecChange: change,
        createdAt: old,
        updatedAt: old,
      })}\n`,
    );
    fs.writeFileSync(path.join(dir, 'status.json'), '{}\n');
    for (const d of ['tasks', 'reviews', 'brainstorm']) fs.mkdirSync(path.join(dir, d));
    return dir;
  };

  const live = plantScaffold('live-plan', 'example-change');
  fs.mkdirSync(path.join(root, 'specs', 'changes', 'example-change'), { recursive: true });
  fs.writeFileSync(path.join(root, 'specs', 'changes', 'example-change', 'proposal.md'), '# why\n');

  const archivedOnly = plantScaffold('archived-plan', 'old-change');
  fs.mkdirSync(path.join(root, 'specs', 'changes', 'archive', '2026-01-01-old-change'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'specs', 'changes', 'archive', '2026-01-01-old-change', 'proposal.md'),
    '# archived\n',
  );

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  const fleet = () => ({
    ...process.env,
    FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-plan-fleet-'), 's'),
  });

  execFileSync(process.execPath, [cleanup], { cwd: root, env: fleet() });

  assert.equal(
    fs.existsSync(live),
    true,
    'live change dir is held work even when the session dir is scaffold-only',
  );
  assert.equal(
    fs.existsSync(archivedOnly),
    false,
    'archive-only change does not protect a scaffold session',
  );

  execFileSync(process.execPath, [cleanup, '--include-unfinished', '--session', 'live-plan'], {
    cwd: root,
    env: fleet(),
  });
  assert.equal(fs.existsSync(live), false, 'naming it still deletes unfinished plan work');
});

test('cleanup retains openspec-engine plan session without plan.dir (F73)', () => {
  // F73: hasLiveChangeDir fell back to DEFAULT_SPECS_DIR when plan.dir was
  // absent, so openspec-engine projects (engine only, no dir) looked under
  // specs/changes/ and deleted aged scaffold sessions that still had a live
  // openspec/changes/<name>/.
  const root = tmp('forge-cleanup-openspec-');
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'openspec' } })}\n`,
  );

  const sessionDir = path.join(root, '.forge', 'sessions', 'live-openspec');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({
      id: 'live-openspec',
      slug: 'live-openspec',
      phase: 'plan',
      planType: 'openspec',
      openspecChange: 'example-change',
      createdAt: old,
      updatedAt: old,
    })}\n`,
  );
  fs.writeFileSync(path.join(sessionDir, 'status.json'), '{}\n');
  for (const d of ['tasks', 'reviews', 'brainstorm']) fs.mkdirSync(path.join(sessionDir, d));

  fs.mkdirSync(path.join(root, 'openspec', 'changes', 'example-change'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openspec', 'changes', 'example-change', 'proposal.md'),
    '# why\n',
  );

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  execFileSync(process.execPath, [cleanup], {
    cwd: root,
    env: {
      ...process.env,
      FORGEKIT_FLEET_DIR: path.join(tmp('forge-cleanup-openspec-fleet-'), 's'),
    },
  });

  assert.equal(
    fs.existsSync(sessionDir),
    true,
    'openspec engine without plan.dir must look under openspec/changes/',
  );
});

test('a stray file in .forge/sessions is not an unreadable session', () => {
  // A `.DS_Store` produced ENOTDIR, which became an `unreadable: true`
  // candidate — so a one-session project's money gate refused *forever* and
  // offered `--session .DS_Store` as the remedy. `cleanup-sessions.mjs` already
  // skipped non-directories; the resolver did not.
  const root = tmp('forge-stray-');
  const dir = path.join(root, '.forge', 'sessions', 'real-one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    `${JSON.stringify({ id: 'real-one', slug: 'real', phase: 'implement' })}\n`,
  );
  fs.writeFileSync(path.join(root, '.forge', 'sessions', '.DS_Store'), 'junk');

  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { unfinishedSessions } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(SESSION_STATUS), 'lib.mjs')).href)};
       process.stdout.write(JSON.stringify(unfinishedSessions()));`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).map((c) => c.id), ['real-one']);
});

test('status and the session-start reminder report ambiguity instead of asserting it', () => {
  // Task 1.4 shipped with **zero** coverage, found by the final review. These
  // two are what an operator and an agent read to learn which session they are
  // on, so agreeing with a pointer the gate would refuse is the whole failure —
  // before this, `status` said one thing and `phase done` did another with
  // nothing on screen to say so.
  const root = tmp('forge-status-ambiguous-');
  const plant = (id, slug) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug, phase: 'implement', createdAt: '2026-07-29T10:00:00.000Z' })}\n`,
    );
  };
  plant('sess-a', 'billing');
  plant('sess-b', 'search');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-a' })}\n`,
  );

  const status = JSON.parse(
    execFileSync(process.execPath, [SESSION_STATUS], { cwd: root, encoding: 'utf8' }),
  );
  assert.equal(status.sessionId, 'sess-a', 'it still answers');
  assert.equal(status.sessionAmbiguity?.ambiguous, true, 'and says the answer was a pointer’s guess');
  assert.deepEqual(
    status.sessionAmbiguity.candidates.map((c) => c.sessionId).sort(),
    ['sess-a', 'sess-b'],
  );
  assert.match(status.sessionAmbiguity.note, /refuse/, 'and what it will cost at the gate');

  const reminder = path.join(path.dirname(SESSION_STATUS), 'session-reminder.mjs');
  const out = execFileSync(process.execPath, [reminder], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Active Forge session: sess-a/);
  assert.match(out, /2 sessions are unfinished/, 'the line the agent believes must say so');
  assert.match(out, /one review per tasks\.md ## group/);

  // With one session open there is nothing to report, and neither should.
  fs.rmSync(path.join(root, '.forge', 'sessions', 'sess-b'), { recursive: true });
  const single = JSON.parse(
    execFileSync(process.execPath, [SESSION_STATUS], { cwd: root, encoding: 'utf8' }),
  );
  assert.equal('sessionAmbiguity' in single, false, 'no noise when there is no ambiguity');
});

test('severity follows what an invocation writes, not what the command is called', () => {
  // F17: four mutants restoring the F1/F2/F7 defects all survived the full
  // suite, so three blocker fixes shipped untested. These are the assertions
  // that were missing.
  const root = tmp('forge-severity-');
  const bin = path.dirname(SESSION_STATUS);
  const plant = (id, slug) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug, phase: 'implement', planType: 'specs', openspecChange: 'c' })}\n`,
    );
  };
  plant('sess-a', 'billing');
  plant('sess-b', 'search');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-a' })}\n`,
  );
  const run = (script, ...args) =>
    spawnSync(process.execPath, [path.join(bin, script), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-sev-fleet-'), 's') },
    });

  // Reads never refuse — refusing there is an obstruction with no damage.
  for (const [script, args] of [
    ['score-cli.mjs', []],
    ['checkpoint.mjs', ['--dry-run']],
    ['checkpoint.mjs', ['--range', '--last']],
    ['brief-cli.mjs', ['check']],
  ]) {
    const r = run(script, ...args);
    assert.equal(
      /Refusing to guess/.test(r.stderr),
      false,
      `${script} ${args.join(' ')} refuses though it writes nothing`,
    );
  }

  // `forge brief stamp` writes the hash `enforceBriefGate` reads, so stamping
  // the neighbour's brief passes *their* implement gate on your approval — and
  // re-running only fixes yours.
  const stamp = run('brief-cli.mjs', 'stamp');
  assert.notEqual(stamp.status, 0);
  assert.match(stamp.stderr, /Refusing to guess/);
});

test('forge evidence will not overwrite another session run it only guessed at', () => {
  // F14. The file is gitignored and `score.mjs` reads it into the evidence
  // ratio that lands in the durable ledger, so clobbering it destroys a record
  // and moves another change's score. Writing a *new* file on a guess is a
  // stray file; replacing one is not.
  const root = tmp('forge-evidence-guess-');
  const plant = (id) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(path.join(dir, 'tasks', '1.1'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
    );
    return dir;
  };
  const a = plant('sess-a');
  plant('sess-b');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-a' })}\n`,
  );
  const existing = path.join(a, 'tasks', '1.1', 'test-evidence.md');
  fs.writeFileSync(existing, '# somebody else’s run\n');

  const record = path.join(path.dirname(SESSION_STATUS), 'record-evidence.mjs');
  const r = spawnSync(
    process.execPath,
    [record, '--task', '1.1', '--command', 'npm test', '--exit', '0', '--summary', 'ok'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.notEqual(r.status, 0, 'a guessed session must not clobber existing evidence');
  assert.equal(fs.readFileSync(existing, 'utf8'), '# somebody else’s run\n', 'and must not have');
  assert.match(`${r.stdout}${r.stderr}`, /--session/);
});

test('a session is what has a session.json, whatever its dirent says', (t) => {
  // F12. The first fix asked the dirent whether it was a directory — a check
  // copied from `cleanup-sessions.mjs`, where skipping means *don't delete* and
  // is safe, into the resolver, where skipping means *don't count* and hides a
  // session from the gate. A symlinked session directory is not
  // `isDirectory()`, so `forge phase done` acted on the pointer with no warning
  // and no refusal.
  const root = tmp('forge-dirent-');
  const outside = tmp('forge-dirent-target-');
  fs.writeFileSync(
    path.join(outside, 'session.json'),
    `${JSON.stringify({ id: 'linked', slug: 'linked', phase: 'implement' })}\n`,
  );
  const sessions = path.join(root, '.forge', 'sessions');
  fs.mkdirSync(path.join(sessions, 'plain'), { recursive: true });
  fs.writeFileSync(
    path.join(sessions, 'plain', 'session.json'),
    `${JSON.stringify({ id: 'plain', slug: 'plain', phase: 'implement' })}\n`,
  );
  try {
    fs.symlinkSync(outside, path.join(sessions, 'linked'));
  } catch (err) {
    // Windows denies unprivileged symlink creation (no admin / Developer Mode)
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      t.skip('symlink creation unavailable in this environment');
      return;
    }
    throw err;
  }
  // And a stray file, which genuinely is not a session.
  fs.writeFileSync(path.join(sessions, '.DS_Store'), 'junk');

  const seen = JSON.parse(
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { unfinishedSessions } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(SESSION_STATUS), 'lib.mjs')).href)};
         process.stdout.write(JSON.stringify(unfinishedSessions().map((c) => c.id).sort()));`,
      ],
      { cwd: root, encoding: 'utf8' },
    ).stdout,
  );
  assert.deepEqual(seen, ['linked', 'plain'], 'a symlinked session still counts');
});

test('the addressable key is the directory name, not the declared id', () => {
  // F15, and this change caused it: `unfinishedSessions` returned the id
  // declared inside `session.json`, while `loadSession` and `--session` address
  // `SESSIONS_DIR/<name>`. A session whose declared id differed from its
  // directory crashed `forge status` with an uncaught "Session not found", and
  // the remedy the gate printed crashed the same way.
  const root = tmp('forge-idkey-');
  const dir = path.join(root, '.forge', 'sessions', 'dirname-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    `${JSON.stringify({ id: 'declared-b', slug: 'x', phase: 'implement' })}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'declared-b' })}\n`,
  );

  const r = spawnSync(process.execPath, [SESSION_STATUS], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `status must not crash:\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.sessionId, 'dirname-a', 'addressed by the directory, which is what exists');
});

test('forge cleanup --session scopes the run and honours --include-unfinished', () => {
  // Three defects in one flag, all found post-publish:
  //   * `--include-unfinished --session <id>` — the remedy the tool itself
  //     prints — silently no-opped when the pointer named that session: exit 0,
  //     empty `removed`, no message.
  //   * `--session` was unvalidated, so a typo was a silent no-op too.
  //   * `--session` scoped nothing, so `forge cleanup --session A` deleted an
  //     unrelated finished session C the operator never named.
  const root = tmp('forge-cleanup-scope-');
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  const plant = (id, phase, work) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase, createdAt: old, updatedAt: old })}\n`,
    );
    if (work) fs.writeFileSync(path.join(dir, 'verify-evidence.md'), 'work\n');
    return dir;
  };
  const mine = plant('mine', 'implement', true);
  const unnamed = plant('unnamed-finished', 'done', false);
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'mine' })}\n`,
  );
  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  const run = (...args) =>
    spawnSync(process.execPath, [cleanup, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-scope-fleet-'), 's') },
    });

  const typo = run('--session', 'no-such-session');
  assert.notEqual(typo.status, 0, 'a typo must not be a silent no-op');
  assert.match(typo.stderr, /No such session/);

  // Scoped: the session named is considered, and nothing else is touched.
  const scoped = run('--session', 'mine', '--include-unfinished');
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(fs.existsSync(mine), false, 'the named session is removed as asked');
  assert.equal(
    fs.existsSync(unnamed),
    true,
    'a session the operator never named must not be swept alongside it',
  );
});

test('forge phase skipped is gated like the other terminal phases', () => {
  // Found post-publish. `skipped` looks harmless and is terminal: the session
  // leaves `unfinishedSessions()`' view so nothing warns about it again, and it
  // writes no digest line because the scorecard is gated on done|finish. A
  // later transition moves the pointer off it and the next bare `forge cleanup`
  // takes it — reviews, evidence and all. `/forge:skip`'s template runs the
  // bare command.
  const root = tmp('forge-skipped-gate-');
  const plant = (id) => {
    const dir = path.join(root, '.forge', 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      `${JSON.stringify({ id, slug: id, phase: 'implement' })}\n`,
    );
  };
  plant('sess-a');
  plant('sess-b');
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 'sess-a' })}\n`,
  );

  const setPhase = path.join(path.dirname(SESSION_STATUS), 'set-phase.mjs');
  const r = spawnSync(process.execPath, [setPhase, 'skipped'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'marking the wrong session terminal is not undone by re-running');
  assert.match(r.stderr, /Refusing to guess/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, '.forge', 'sessions', 'sess-a', 'session.json'), 'utf8')).phase,
    'implement',
    'and nothing moved',
  );
});

test('a fleet inbox note is not work the session did', () => {
  // `forge new` plants a note in every *other* open session, so counting
  // `inbox/` as work made an abandoned session permanently unclearable — the
  // "gate refuses forever" failure restored through a side door.
  const root = tmp('forge-inbox-work-');
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  const dir = path.join(root, '.forge', 'sessions', 'abandoned');
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    `${JSON.stringify({ id: 'abandoned', slug: 'x', phase: 'implement', createdAt: old, updatedAt: old })}\n`,
  );
  fs.writeFileSync(path.join(dir, 'status.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'inbox', '20260729-note.md'), 'another session said hello\n');

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  spawnSync(process.execPath, [cleanup], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-inbox-fleet-'), 's') },
  });
  assert.equal(fs.existsSync(dir), false, 'an inbox note must not make a session unclearable');
});

test('forge cleanup says why a named session survived', () => {
  // Round 4. `--session <id>` is a request about one session, so an empty
  // `removed` list and exit 0 is the same silence the typo check was written to
  // end — and it fired on the ordinary cases: a session younger than retention
  // (which is the remedy the tool itself prints) and one whose session.json
  // could not be read.
  const root = tmp('forge-cleanup-why-');
  const now = new Date().toISOString();
  const fresh = path.join(root, '.forge', 'sessions', 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(
    path.join(fresh, 'session.json'),
    `${JSON.stringify({ id: 'fresh', slug: 'fresh', phase: 'implement', createdAt: now, updatedAt: now })}\n`,
  );
  const broken = path.join(root, '.forge', 'sessions', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'session.json'), '{"id":"bro');

  const cleanup = path.join(path.dirname(SESSION_STATUS), 'cleanup-sessions.mjs');
  const run = (...args) =>
    spawnSync(process.execPath, [cleanup, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('forge-why-fleet-'), 's') },
    });

  const young = run('--session', 'fresh', '--include-unfinished');
  assert.match(young.stderr, /Kept fresh/);
  assert.match(young.stderr, /retention is \d+ days/, 'and says what would change it');
  assert.equal(fs.existsSync(fresh), true);

  const unreadable = run('--session', 'broken');
  assert.match(unreadable.stderr, /Kept broken/);
  assert.match(unreadable.stderr, /no readable session\.json/);

  // `--session` with nothing after it crashed with an uncaught
  // ERR_INVALID_ARG_TYPE, introduced by the typo validation itself.
  const bare = run('--session');
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /--session needs a session id/);
  assert.equal(/ERR_INVALID_ARG_TYPE/.test(bare.stderr), false, 'and must not be a stack trace');
});

test('hasBlockedMarker: whole-line discipline (F89)', async () => {
  const { hasBlockedMarker } = await import('./lib.mjs');
  // Markers: a line owned by BLOCKED, bare or as a heading.
  assert.equal(hasBlockedMarker('BLOCKED: cannot verify\n'), true);
  assert.equal(hasBlockedMarker('# Verify\n\nBLOCKED — no runtime owner.\n'), true);
  assert.equal(hasBlockedMarker('## BLOCKED\n\nThe queue worker is down.\n'), true);
  // Prose: a mid-sentence mention is not a marker.
  assert.equal(hasBlockedMarker('The subagent reported BLOCKED in its status.\n'), false);
  assert.equal(hasBlockedMarker('See the BLOCKED section of the runbook.\n'), false);
  assert.equal(hasBlockedMarker(''), false);
});
