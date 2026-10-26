import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportEscapeReplays } from './export-escape-replays.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-escape-replays.mjs');
const OPT_IN = { FORGEKIT_ALLOW_EXEC: '1' };
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const REPLAY_COMMAND = 'node node_modules/jest/bin/jest.js {file}';
const SLUG = 'order-refunds';

// The registry of running sessions is the operator's; keep the tests off it.
const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-export-fleet-'));
process.env.FORGEKIT_FLEET_DIR = fleetDir;
test.after(() => fs.rmSync(fleetDir, { recursive: true, force: true }));

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args, at = T0) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
    }).trim();
  git(['init', '-q']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git(['config', k, v]);
  const commit = (files, subject, at) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git(['add', '-A'], at);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
  };
  return { commit };
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/**
 * A project root holding a nested repo `web/` with a base commit, two session commits, and two
 * later fix commits that each add a test; a done session around the session commits; two
 * confirmed escapes; a Jest replay rule; and an archived change for the session's slug.
 */
function project(t, { spec = true, ranges = false, window = true, command = REPLAY_COMMAND, extraRows = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-export-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const web = path.join(root, 'web');
  const r = repo(web);
  const base = r.commit({ '.gitignore': '.env\nnode_modules/\n', 'server/src/orders.js': 'module.exports = 1;\n', 'server/package.json': '{}\n' }, 'chore: base', T0 - DAY);
  write(path.join(web, 'server', '.env'), 'SECRET=hunter2\n');
  const s1 = r.commit({ 'server/src/orders.js': 'module.exports = 2;\n' }, 'feat: refunds', T0 + 600000);
  const s2 = r.commit({ 'server/src/refunds.js': 'module.exports = 3;\n' }, 'feat: refund route', T0 + 1200000);
  const f1 = r.commit({ 'server/test/orders.test.js': 'test("a", () => {});\n' }, 'fix: orders', T0 + DAY);
  const f2 = r.commit({ 'server/test/refunds.test.js': 'test("b", () => {});\n' }, 'fix: refunds', T0 + DAY + 60000);

  const sessionId = 'sess-1';
  const started = window ? T0 : T0 - 30 * DAY;
  write(
    path.join(root, '.forge', 'sessions.jsonl'),
    jsonl([
      {
        phase: 'done',
        sessionId,
        slug: SLUG,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(started + 2 * 3600000).toISOString(),
        ...(ranges && { nestedCommitRanges: { web: { base, head: s2 } } }),
      },
    ]),
  );
  const row = (commit, replayTest) => ({ sessionId, slug: SLUG, commit, repo: 'web', replayTest, decision: 'confirmed', command: 'node node_modules/jest/bin/jest.js test/x' });
  write(
    path.join(root, '.forge', 'escapes.jsonl'),
    jsonl([row(f1, 'server/test/orders.test.js'), row(f2, 'server/test/refunds.test.js'), ...extraRows.map((x) => ({ sessionId, slug: SLUG, decision: 'confirmed', ...x }))]),
  );
  write(path.join(root, '.forge', 'config.json'), JSON.stringify({ escapes: { replay: [{ match: 'web/server/test/**', cwd: 'web/server', command, copy: ['.env'] }] } }));

  if (spec) {
    const archive = path.join(root, 'specs', 'changes', 'archive', `2026-10-02-${SLUG}`);
    write(path.join(archive, 'proposal.md'), '## Why\n\nPROPOSAL-MARKER refunds are missing.\n');
    write(path.join(archive, 'specs', 'refunds', 'spec.md'), '### Requirement: Refund\n\nSPEC-MARKER refunds restock.\n');
    write(path.join(archive, 'design.md'), 'DESIGN-MARKER use a ledger.\n');
    write(path.join(archive, 'tasks.md'), 'TASKS-MARKER - [ ] 1.1 build.\n');
    write(path.join(archive, 'brief.html'), '<p>BRIEF-MARKER</p>\n');
  }
  // Another archived change whose slug merely ends the same way must not be taken for this one.
  write(path.join(root, 'specs', 'changes', 'archive', `2026-10-03-big-${SLUG}`, 'proposal.md'), 'WRONG-CHANGE\n');
  const out = `${root}-out`;
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return { root, web, out, shas: { base, s1, s2, f1, f2 } };
}

const run = (p, extra = {}) => exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, ...extra });
const appDir = (p) => path.join(p.out, 'tasks', SLUG, 'environment', 'app');

test('export refuses without the exec opt-in, names it, and writes nothing', (t) => {
  const p = project(t);
  const env = { ...process.env };
  delete env.FORGEKIT_ALLOW_EXEC;
  const r = spawnSync(process.execPath, [script, '--project', p.root, '--out', p.out], { encoding: 'utf8', env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /FORGEKIT_ALLOW_EXEC=1/);
  assert.equal(fs.existsSync(p.out), false);
});

test('a session with two confirmed fixes becomes one candidate task', async (t) => {
  const p = project(t);
  const { kept, drops, report } = await run(p);
  assert.deepEqual(drops, []);
  assert.equal(kept.length, 1);
  const [task] = kept;
  assert.equal(task.sessionId, 'sess-1');
  assert.equal(task.repo, 'web');
  assert.equal(task.base, p.shas.base);
  assert.equal(task.head, p.shas.s2);
  assert.equal(task.inferred, true);
  assert.deepEqual(task.fixes.map((f) => f.commit), [p.shas.f1, p.shas.f2]);
  assert.deepEqual(task.hiddenTests.map((h) => h.path).sort(), ['server/test/orders.test.js', 'server/test/refunds.test.js']);
  assert.deepEqual(task.hiddenTests.find((h) => h.path === 'server/test/orders.test.js').argv, ['node', 'node_modules/jest/bin/jest.js', 'test/orders.test.js']);
  assert.equal(task.hiddenTests[0].cwd, 'web/server');
  assert.equal(task.rule.cwd, 'web/server');

  const written = JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(report)));
  assert.equal(written.candidates.length, 1);
  assert.equal(written.candidates[0].taskId, SLUG);
  assert.equal(written.candidates[0].instruction, undefined);
});

test('a recorded nestedCommitRanges entry is used instead of inference', async (t) => {
  const p = project(t, { ranges: true });
  const { kept } = await run(p);
  assert.equal(kept[0].inferred, false);
  assert.equal(kept[0].base, p.shas.base);
  assert.equal(kept[0].head, p.shas.s2);
});

test('the snapshot is the nested repo at base: tracked files only, no .git, no ignored .env', async (t) => {
  const p = project(t);
  await run(p);
  assert.equal(fs.readFileSync(path.join(appDir(p), 'server', 'src', 'orders.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.existsSync(path.join(appDir(p), 'server', 'src', 'refunds.js')), false, 'later work is not in the base');
  assert.equal(fs.existsSync(path.join(appDir(p), '.git')), false);
  assert.equal(fs.existsSync(path.join(appDir(p), 'server', '.env')), false);
});

test('--include copies a named ignored file from the nested checkout', (t) => {
  const p = project(t);
  const r = spawnSync(process.execPath, [script, '--project', p.root, '--out', p.out, '--include', 'server/.env'], { encoding: 'utf8', env: { ...process.env, ...OPT_IN } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(appDir(p), 'server', '.env'), 'utf8'), 'SECRET=hunter2\n');
  assert.equal(JSON.parse(r.stdout).candidates[0].included[0], 'server/.env');
});

test('--include refuses absolute paths and ".." segments before writing anything', async (t) => {
  const p = project(t);
  const outside = path.join(os.tmpdir(), 'passwd');
  for (const bad of [outside, '/etc/passwd', 'C:\\Windows\\win.ini', '../secret', 'server/../../secret', 'server\\..\\..\\secret']) {
    await assert.rejects(run(p, { include: [bad] }), /--include/, bad);
    assert.equal(fs.existsSync(p.out), false, `nothing written for ${bad}`);
  }
});

test('--include of a file no nested checkout holds is an error, before writing', async (t) => {
  const p = project(t);
  await assert.rejects(run(p, { include: ['server/.missing'] }), /not found/);
  assert.equal(fs.existsSync(p.out), false);
});

test('the instruction holds the proposal and the specs and nothing of design, tasks or the brief', async (t) => {
  const p = project(t);
  const { kept } = await run(p);
  const text = kept[0].instruction;
  assert.match(text, /PROPOSAL-MARKER/);
  assert.match(text, /SPEC-MARKER/);
  assert.ok(text.indexOf('PROPOSAL-MARKER') < text.indexOf('SPEC-MARKER'), 'proposal first');
  for (const marker of ['DESIGN-MARKER', 'TASKS-MARKER', 'BRIEF-MARKER', 'WRONG-CHANGE']) assert.doesNotMatch(text, new RegExp(marker));
});

test('a session with no archived change is dropped as no-spec', async (t) => {
  const p = project(t, { spec: false });
  const { kept, drops } = await run(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'no-spec' }]);
  assert.equal(fs.existsSync(path.join(p.out, 'tasks')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8')).drops, drops);
});

test('a session with no attributable commits is dropped as no-base', async (t) => {
  const p = project(t, { window: false });
  const { kept, drops } = await run(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'no-base' }]);
});

test('a replay rule that is not Jest is dropped as unsupported-runner', async (t) => {
  const p = project(t, { command: 'pytest {file}' });
  const { kept, drops } = await run(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'unsupported-runner' }]);
});

test('a fix with no replay rule at all is unsupported-runner too', async (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, '.forge', 'config.json'), '{}');
  const { drops } = await run(p);
  assert.deepEqual(drops.map((d) => d.reason), ['unsupported-runner']);
});

test('escapes in another repository are skipped as unsupported-runner, not exported', async (t) => {
  const p = project(t, { extraRows: [{ commit: 'c'.repeat(40), repo: 'mobile', replayTest: 'src/a.test.ts' }] });
  const { kept } = await run(p);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].repo, 'web');
  assert.deepEqual(kept[0].skippedEscapes, [{ commit: 'c'.repeat(40), reason: 'unsupported-runner' }]);
  assert.equal(kept[0].fixes.length, 2);
});

test('dismissed decisions and superseded rows are ignored', async (t) => {
  const p = project(t);
  const ledger = path.join(p.root, '.forge', 'escapes.jsonl');
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows.push({ ...rows[1], decision: 'dismissed' });
  fs.writeFileSync(ledger, jsonl(rows));
  const { kept } = await run(p);
  assert.deepEqual(kept[0].fixes.map((f) => f.commit), [p.shas.f1]);
});
