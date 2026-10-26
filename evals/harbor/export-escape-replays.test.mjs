import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertOutDirSafe, exportEscapeReplays, parseArgs, prepareCandidates, snapshotBase } from './export-escape-replays.mjs';
import { DAY, T0, jsonl, repo, write } from './escape-replays/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'export-escape-replays.mjs');
const OPT_IN = { FORGEKIT_ALLOW_EXEC: '1' };
const REPLAY_COMMAND = 'node node_modules/jest/bin/jest.js {file}';
const SLUG = 'order-refunds';

// The registry of running sessions is the operator's; keep the tests off it.
const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-export-fleet-'));
process.env.FORGEKIT_FLEET_DIR = fleetDir;
test.after(() => fs.rmSync(fleetDir, { recursive: true, force: true }));

/**
 * A project root holding a nested repo `web/` with a base commit, two session commits, and two
 * later fix commits that each add a test; a done session around the session commits; two
 * confirmed escapes; a replay rule; and an archived change for the session's slug.
 */
function project(t, { slug = SLUG, spec = true, ranges = false, window = true, command = REPLAY_COMMAND, extraRows = [], autocrlf = false, symlink = false, baseFiles = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-export-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const web = path.join(root, 'web');
  const r = repo(web);
  let base = r.commit({ '.gitignore': '.env\nnode_modules/\n', 'server/src/orders.js': 'module.exports = 1;\n', 'server/package.json': '{}\n', ...baseFiles }, 'chore: base', T0 - DAY);
  if (symlink) {
    // A symlink entry (mode 120000) committed through plumbing, so it works on hosts without symlink rights.
    const blob = r.git(['hash-object', '-w', '--stdin'], T0, 'orders.js');
    r.git(['update-index', '--add', '--cacheinfo', `120000,${blob},server/src/link.js`]);
    r.git(['commit', '-qm', 'chore: link'], T0 - DAY + 1000);
    base = r.git(['rev-parse', 'HEAD']);
  }
  write(path.join(web, 'server', '.env'), 'SECRET=hunter2\n');
  const s1 = r.commit({ 'server/src/orders.js': 'module.exports = 2;\n' }, 'feat: refunds', T0 + 600000);
  const s2 = r.commit({ 'server/src/refunds.js': 'module.exports = 3;\n' }, 'feat: refund route', T0 + 1200000);
  const f1 = r.commit({ 'server/test/orders.test.js': 'test("a", () => {});\n' }, 'fix: orders', T0 + DAY);
  const f2 = r.commit({ 'server/test/refunds.test.js': 'test("b", () => {});\n' }, 'fix: refunds', T0 + DAY + 60000);
  if (autocrlf) r.git(['config', 'core.autocrlf', 'true']);

  const sessionId = 'sess-1';
  const started = window ? T0 : T0 - 30 * DAY;
  write(
    path.join(root, '.forge', 'sessions.jsonl'),
    jsonl([
      {
        phase: 'done',
        sessionId,
        slug,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(started + 2 * 3600000).toISOString(),
        ...(ranges && { nestedCommitRanges: { web: { base, head: s2 } } }),
      },
    ]),
  );
  const row = (commit, replayTest) => ({ sessionId, slug, commit, repo: 'web', replayTest, decision: 'confirmed', command: 'node node_modules/jest/bin/jest.js test/x' });
  write(
    path.join(root, '.forge', 'escapes.jsonl'),
    jsonl([row(f1, 'server/test/orders.test.js'), row(f2, 'server/test/refunds.test.js'), ...extraRows.map((x) => ({ sessionId, slug, decision: 'confirmed', ...x }))]),
  );
  write(path.join(root, '.forge', 'config.json'), JSON.stringify({ escapes: { replay: [{ match: 'web/server/test/**', cwd: 'web/server', command, copy: ['.env'] }] } }));

  if (spec) {
    const archive = path.join(root, 'specs', 'changes', 'archive', `2026-10-02-${slug}`);
    write(path.join(archive, 'proposal.md'), '## Why\n\nPROPOSAL-MARKER refunds are missing.\n');
    write(path.join(archive, 'specs', 'refunds', 'spec.md'), '### Requirement: Refund\n\nSPEC-MARKER refunds restock.\n');
    write(path.join(archive, 'design.md'), 'DESIGN-MARKER use a ledger.\n');
    write(path.join(archive, 'tasks.md'), 'TASKS-MARKER - [ ] 1.1 build.\n');
    write(path.join(archive, 'brief.html'), '<p>BRIEF-MARKER</p>\n');
  }
  // Another archived change whose slug merely ends the same way must not be taken for this one.
  write(path.join(root, 'specs', 'changes', 'archive', `2026-10-03-big-${slug}`, 'proposal.md'), 'WRONG-CHANGE\n');
  const out = `${root}-out`;
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return { root, web, out, repo: r, shas: { base, s1, s2, f1, f2 } };
}

/** Collect and snapshot only: no commands run. */
const prepare = (p, extra = {}) => prepareCandidates({ project: p.root, out: p.out, ...extra });
const full = (p, extra = {}) => exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, ...extra });
const appDir = (p, id = SLUG) => path.join(p.out, 'tasks', id, 'environment', 'app');

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
  const { kept, drops } = await prepare(p);
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
});

test('a recorded nestedCommitRanges entry is used instead of inference', async (t) => {
  const p = project(t, { ranges: true });
  const { kept } = await prepare(p);
  assert.equal(kept[0].inferred, false);
  assert.equal(kept[0].base, p.shas.base);
  assert.equal(kept[0].head, p.shas.s2);
});

test('the snapshot is the nested repo at base: tracked files only, no .git, no ignored .env', async (t) => {
  const p = project(t);
  await prepare(p);
  assert.equal(fs.readFileSync(path.join(appDir(p), 'server', 'src', 'orders.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.existsSync(path.join(appDir(p), 'server', 'src', 'refunds.js')), false, 'later work is not in the base');
  assert.equal(fs.existsSync(path.join(appDir(p), '.git')), false);
  assert.equal(fs.existsSync(path.join(appDir(p), 'server', '.env')), false);
});

test('the snapshot keeps LF bytes even when the nested repo converts line endings (core.autocrlf=true)', async (t) => {
  const p = project(t, { autocrlf: true });
  await prepare(p);
  const bytes = fs.readFileSync(path.join(appDir(p), 'server', 'src', 'orders.js'));
  assert.equal(bytes.toString('latin1'), 'module.exports = 1;\n');
  assert.equal(bytes.includes(0x0d), false, 'no CR in the snapshot');
});

test('--include copies a named ignored file from the nested checkout', async (t) => {
  const p = project(t);
  const { kept } = await prepare(p, { include: ['server/.env'] });
  assert.equal(fs.readFileSync(path.join(appDir(p), 'server', '.env'), 'utf8'), 'SECRET=hunter2\n');
  assert.deepEqual(kept[0].included, ['server/.env']);
});

test('--include refuses absolute paths and ".." segments even when the target exists, and writes nothing', async (t) => {
  const p = project(t);
  // Every one of these resolves to a file that exists, so only the path check can refuse them.
  const outside = path.join(os.tmpdir(), `forgekit-include-outside-${process.pid}`);
  fs.writeFileSync(outside, 'outside\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  write(path.join(p.root, 'secret'), 'top-secret\n');
  const cases = [
    [outside, /must be a relative path/],
    ['/etc/passwd', /must be a relative path/],
    ['C:\\Windows\\win.ini', /must be a relative path/],
    ['../secret', /must not contain "\.\."/],
    ['server/../../secret', /must not contain "\.\."/],
    ['server\\..\\..\\secret', /must not contain "\.\."/],
  ];
  for (const [bad, wording] of cases) {
    await assert.rejects(prepare(p, { include: [bad] }), wording, bad);
    assert.equal(fs.existsSync(p.out), false, `nothing written for ${bad}`);
  }
});

test('--include of a file no nested checkout holds is an error, before writing', async (t) => {
  const p = project(t);
  await assert.rejects(prepare(p, { include: ['server/.missing'] }), /not found/);
  assert.equal(fs.existsSync(p.out), false);
});

test('--include while every session is dropped still writes the report', async (t) => {
  const p = project(t, { spec: false });
  const { drops } = await full(p, { include: ['server/.env'] });
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'no-spec' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8')).drops, drops);
});

test('the instruction holds the proposal and the specs and nothing of design, tasks or the brief', async (t) => {
  const p = project(t);
  const { kept } = await prepare(p);
  const text = kept[0].instruction;
  assert.match(text, /PROPOSAL-MARKER/);
  assert.match(text, /SPEC-MARKER/);
  assert.ok(text.indexOf('PROPOSAL-MARKER') < text.indexOf('SPEC-MARKER'), 'proposal first');
  for (const marker of ['DESIGN-MARKER', 'TASKS-MARKER', 'BRIEF-MARKER', 'WRONG-CHANGE']) assert.doesNotMatch(text, new RegExp(marker));
});

test('a session with no archived change is dropped as no-spec', async (t) => {
  const p = project(t, { spec: false });
  const { kept, drops } = await full(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'no-spec' }]);
  assert.equal(fs.existsSync(path.join(p.out, 'tasks')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.out, 'export-report.json'), 'utf8')).drops, drops);
});

test('a session with no attributable commits is dropped as no-base', async (t) => {
  const p = project(t, { window: false });
  const { kept, drops } = await prepare(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'no-base' }]);
});

test('the verifier is runner-agnostic: a pytest replay rule is exported like any other', async (t) => {
  const p = project(t, { command: 'pytest {file}' });
  const { kept, drops } = await prepare(p);
  assert.deepEqual(drops, []);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].hiddenTests.map((h) => h.argv).sort(), [['pytest', 'test/orders.test.js'], ['pytest', 'test/refunds.test.js']]);
});

test('a fix with no replay rule at all is unsupported-runner', async (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, '.forge', 'config.json'), '{}');
  const { drops } = await prepare(p);
  assert.deepEqual(drops.map((d) => d.reason), ['unsupported-runner']);
});

test('escapes in another repository are skipped as unsupported-runner, not exported', async (t) => {
  const p = project(t, { extraRows: [{ commit: 'c'.repeat(40), repo: 'mobile', replayTest: 'src/a.test.ts' }] });
  const { kept } = await prepare(p);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].repo, 'web');
  assert.deepEqual(kept[0].skippedEscapes, [{ commit: 'c'.repeat(40), reason: 'unsupported-runner' }]);
  assert.equal(kept[0].fixes.length, 2);
});

test('the session repository is the one with the most rule-backed escapes, not the most escapes', async (t) => {
  // mobile has three escapes but no replay rule; web has two that do.
  const extraRows = ['a', 'b', 'c'].map((c) => ({ commit: c.repeat(40), repo: 'mobile', replayTest: `src/${c}.test.ts` }));
  const p = project(t, { extraRows });
  const { kept, drops } = await prepare(p);
  assert.deepEqual(drops, []);
  assert.equal(kept[0].repo, 'web');
  assert.equal(kept[0].fixes.length, 2);
  assert.equal(kept[0].skippedEscapes.length, 3);
});

test('a ledger repo or replayTest that escapes the repository is skipped as unsafe-path', async (t) => {
  const bad = [
    { commit: 'a'.repeat(40), repo: 'web', replayTest: '../../evil.test.js' },
    { commit: 'b'.repeat(40), repo: 'web', replayTest: '/etc/evil.test.js' },
    { commit: 'c'.repeat(40), repo: '../evil', replayTest: 'x.test.js' },
    { commit: 'd'.repeat(40), repo: 'C:\\evil', replayTest: 'x.test.js' },
  ];
  const p = project(t, { extraRows: bad });
  const { kept } = await prepare(p);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].fixes.map((f) => f.commit), [p.shas.f1, p.shas.f2]);
  assert.deepEqual(kept[0].skippedEscapes, bad.map((b) => ({ commit: b.commit, reason: 'unsafe-path' })));
});

test('a session whose every escape has an unsafe path is dropped as unsafe-path', async (t) => {
  const p = project(t);
  const ledger = path.join(p.root, '.forge', 'escapes.jsonl');
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => ({ ...JSON.parse(l), replayTest: '../../x.test.js' }));
  fs.writeFileSync(ledger, jsonl(rows));
  const { kept, drops } = await prepare(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops.map((d) => d.reason), ['unsafe-path']);
});

test('a slug with no usable characters gets a hash task id', async (t) => {
  const p = project(t, { slug: '!!!' });
  const { kept } = await prepare(p);
  assert.equal(kept.length, 1);
  assert.match(kept[0].taskId, /^escape-[0-9a-f]{10}$/);
  assert.equal(fs.existsSync(appDir(p, kept[0].taskId)), true);
});

test('a base snapshot that holds a symlink drops the session as unsafe-tree, before extracting', async (t) => {
  const p = project(t, { symlink: true });
  const { kept, drops } = await prepare(p);
  assert.deepEqual(kept, []);
  assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'unsafe-tree' }]);
  assert.equal(fs.existsSync(path.join(p.out, 'tasks')), false);
});

test('a base whose .gitattributes uses export-ignore or export-subst drops the session as unsafe-tree', async (t) => {
  // git archive would silently leave those files out, or rewrite them: the snapshot would not be the base.
  for (const [file, text] of [['.gitattributes', 'docs/ export-ignore\n'], ['server/.gitattributes', '*.js text\nVERSION export-subst\n']]) {
    const p = project(t, { baseFiles: { [file]: text } });
    const { kept, drops } = await prepare(p);
    assert.deepEqual(kept, [], file);
    assert.deepEqual(drops, [{ sessionId: 'sess-1', slug: SLUG, reason: 'unsafe-tree' }], file);
    assert.equal(fs.existsSync(path.join(p.out, 'tasks')), false, file);
  }
});

test('other .gitattributes content, and a comment that mentions export-ignore, are fine', async (t) => {
  const p = project(t, { baseFiles: { '.gitattributes': '# not export-ignore here\n* text=auto\n*.png binary\n' } });
  const { kept, drops } = await prepare(p);
  assert.deepEqual(drops, []);
  assert.equal(kept.length, 1);
});

test('dismissed decisions and superseded rows are ignored', async (t) => {
  const p = project(t);
  const ledger = path.join(p.root, '.forge', 'escapes.jsonl');
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows.push({ ...rows[1], decision: 'dismissed' });
  fs.writeFileSync(ledger, jsonl(rows));
  const { kept } = await prepare(p);
  assert.deepEqual(kept[0].fixes.map((f) => f.commit), [p.shas.f1]);
});

test('snapshotBase reports a missing tar and a tar that stops reading as errors, not crashes', async (t) => {
  const p = project(t);
  const dest = path.join(p.out, 'snap');
  await assert.rejects(snapshotBase({ repoDir: p.web, base: p.shas.base, dest, tar: ['forgekit-no-such-tar', '-xf', '-'] }), /could not run/);
  await assert.rejects(snapshotBase({ repoDir: p.web, base: p.shas.base, dest, tar: [process.execPath, '-e', 'process.exit(3)'] }), /could not extract/);
  await assert.rejects(snapshotBase({ repoDir: p.web, base: '0'.repeat(40), dest }), /could not extract/);
});

test('--out inside the forgekit checkout is refused unless git ignores it', () => {
  const checkout = path.resolve(here, '..', '..');
  assert.throws(() => assertOutDirSafe(path.join(checkout, 'evals', 'harbor', 'not-ignored-out')), /ignored/);
  assert.doesNotThrow(() => assertOutDirSafe(path.join(checkout, 'evals', 'harbor', 'local', 'forgekit-escape-replays-v1')));
  assert.doesNotThrow(() => assertOutDirSafe(path.join(os.tmpdir(), 'forgekit-out-elsewhere')));
});

test('a refused --out writes nothing', (t) => {
  const p = project(t);
  const out = path.join(here, 'not-ignored-out');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [script, '--project', p.root, '--out', out], { encoding: 'utf8', env: { ...process.env, ...OPT_IN } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ignored/);
  assert.equal(fs.existsSync(out), false);
});

test('the default out dir follows FORGEKIT_EVALS_LOCAL_ROOT', (t) => {
  const p = project(t, { spec: false });
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-local-root-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [script, '--project', p.root], { encoding: 'utf8', env: { ...process.env, ...OPT_IN, FORGEKIT_EVALS_LOCAL_ROOT: localRoot } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(localRoot, 'forgekit-escape-replays-v1', 'export-report.json')), true);
});

test('parseArgs takes repeated --include and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--project', 'p', '--include', 'a', '--include', 'b']).include, ['a', 'b']);
  assert.throws(() => parseArgs(['--project', 'p', '--bogus', 'x']), /unknown argument/);
});

test('eslint ignores the local corpus folder', () => {
  const config = fs.readFileSync(path.join(here, '..', '..', 'eslint.config.mjs'), 'utf8');
  assert.match(config, /'evals\/harbor\/local\/\*\*'/);
});
