import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertSafeTaskTree, parseCampaign } from './corpus-selection.mjs';
import { DEFAULT_REPLAY_TIMEOUT_SEC } from '../../packages/cli/src/escapes-replay.mjs';
import { exportEscapeReplays } from './export-escape-replays.mjs';
import { writeTask } from './escape-replays/write-task.mjs';
import { scratchProject } from './escape-replays/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const graderTemplate = path.join(here, 'escape-replays', 'grader.mjs');
const OPT_IN = { FORGEKIT_ALLOW_EXEC: '1' };
const HIDDEN = 'server/test/total.test.js';
const SMOKE = 'server/test/smoke.test.js';
const PINNED_NODE = 'node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a';

// The registry of running sessions is the operator's; keep the tests off it.
const fleetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-task-fleet-'));
process.env.FORGEKIT_FLEET_DIR = fleetDir;
test.after(() => fs.rmSync(fleetDir, { recursive: true, force: true }));

const nodeTest = (body) => `const test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const totalIs = (n) => nodeTest(`test('total is ${n}', () => assert.equal(require('../src/total').total(), ${n}));`);
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** An exported project with one kept task: the fix turns total() from 2 (escaped head) into 3. */
async function exported(t, { packageJson = '{}\n', lockfile = 'package-lock.json', baseFiles = {}, sessionFiles, fixes } = {}) {
  const p = scratchProject(t, {
    baseFiles: {
      '.gitignore': '.env\nnode_modules/\n',
      'server/package.json': packageJson,
      ...(lockfile && { [`server/${lockfile}`]: '{}\n' }),
      ...baseFiles,
      'server/src/total.js': 'exports.total = () => 1;\n',
      [SMOKE]: nodeTest("test('total exists', () => assert.equal(typeof require('../src/total').total, 'function'));"),
    },
    sessionFiles: sessionFiles ?? [{ 'server/src/total.js': 'exports.total = () => 2;\n' }],
    fixes: fixes ?? [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', [HIDDEN]: totalIs(3) }, test: HIDDEN }],
  });
  const result = await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  return { p, ...result, dir: path.join(p.out, 'tasks', p.slug) };
}

const read = (file) => fs.readFileSync(file, 'utf8');

/** Grade an app tree with the task's own grader, locally: no Docker, no untrusted user. */
function grade(t, taskDir, appDir, extraEnv = {}) {
  const rewardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-reward-'));
  t.after(() => fs.rmSync(rewardDir, { recursive: true, force: true }));
  const env = { ...process.env, APP_DIR: appDir, TESTS_DIR: path.join(taskDir, 'tests'), HARBOR_REWARD_DIR: rewardDir };
  delete env.HARBOR_UNTRUSTED_UID;
  delete env.HARBOR_UNTRUSTED_GID;
  Object.assign(env, extraEnv);
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(taskDir, 'tests', 'grader.mjs')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(read(path.join(rewardDir, 'reward.json')));
}

/** A scratch copy of the task's agent snapshot, as the agent's /app would start. */
function appCopy(t, taskDir) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-app-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  fs.cpSync(path.join(taskDir, 'environment', 'app'), app, { recursive: true });
  return app;
}

test('a kept task writes the files a Harbor task needs', async (t) => {
  const { dir, kept } = await exported(t);
  assert.equal(kept.length, 1);
  for (const rel of [
    'task.toml', 'instruction.md', 'environment/Dockerfile', 'environment/app/server/src/total.js',
    'tests/Dockerfile', 'tests/test.sh', 'tests/grader.mjs', 'tests/hidden.json',
    `tests/hidden/${HIDDEN}`, `tests/regression/${SMOKE}`, 'solution/solve.sh', 'solution/reference.patch',
  ]) assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
  assert.equal(read(path.join(dir, 'tests', 'grader.mjs')), read(graderTemplate), 'one grader template');
  assert.match(read(path.join(dir, 'instruction.md')), /PROPOSAL-MARKER[\s\S]*SPEC-MARKER/);
  assert.doesNotMatch(read(path.join(dir, 'instruction.md')), /DESIGN-MARKER/);
});

test('task.toml declares a separate no-network verifier and the source metadata', async (t) => {
  const { dir, p } = await exported(t);
  const toml = read(path.join(dir, 'task.toml'));
  assert.match(toml, /^schema_version = "1\.4"$/m);
  assert.match(toml, /^name = "forgekit-escape-replays-v1\/order-refunds"$/m);
  assert.match(toml, /^version = "1\.0\.0"$/m);
  assert.match(toml, /^\[agent\]\s*\ntimeout_sec = \d+\.0$/m);
  assert.match(toml, /^\[verifier\]\s*\ntimeout_sec = \d+\.0\s*\nenvironment_mode = "separate"$/m);
  assert.match(toml, /^\[verifier\.environment\][\s\S]*?network_mode = "no-network"/m);
  assert.match(toml, /^\[environment\][\s\S]*?network_mode = "public"/m);
  assert.match(toml, new RegExp(`^source_session = "sess-1"$`, 'm'));
  assert.match(toml, /^source_slug = "order-refunds"$/m);
  assert.match(toml, /^source_repo = "web"$/m);
  assert.match(toml, /^inferred = true$/m);
  assert.match(toml, new RegExp(`^base_commit = "${p.shas.base}"$`, 'm'));
  assert.match(toml, new RegExp(`^head_commit = "${p.shas.session[0]}"$`, 'm'));
  assert.match(toml, new RegExp(`^fix_commits = \\["${p.shas.fixes[0]}"\\]$`, 'm'));
});

test('the agent Dockerfile pins the node image, installs per rule cwd, and keeps the install marker', async (t) => {
  const { dir } = await exported(t);
  const docker = read(path.join(dir, 'environment', 'Dockerfile'));
  assert.ok(docker.startsWith(`FROM ${PINNED_NODE}\n`));
  assert.match(docker, /^COPY app\/ \/app\/$/m);
  assert.match(docker, /^WORKDIR \/app\/server\nRUN npm ci$/m);
  assert.match(docker, /^# FORGEKIT_INSTALL_MARKER: /m);
  assert.doesNotMatch(docker, /mongodb/i, 'no MongoDB prefetch without the dependency');
  assert.ok(docker.indexOf('npm ci') < docker.indexOf('FORGEKIT_INSTALL_MARKER'));
});

test('a project without a lockfile is dropped as unpinned-deps and gets no task', async (t) => {
  const { kept, drops, dir } = await exported(t, { lockfile: null });
  assert.deepEqual(kept, []);
  assert.deepEqual(drops.map((d) => d.reason), ['unpinned-deps']);
  assert.equal(fs.existsSync(dir), false);
});

test('the lockfile picks the install command in both images', async (t) => {
  for (const [lockfile, command] of [['yarn.lock', 'yarn install --frozen-lockfile'], ['pnpm-lock.yaml', 'corepack enable && pnpm install --frozen-lockfile'], ['npm-shrinkwrap.json', 'npm ci']]) {
    const { dir } = await exported(t, { lockfile });
    assert.match(read(path.join(dir, 'environment', 'Dockerfile')), new RegExp(`^WORKDIR /app/server\nRUN ${command}$`, 'm'), lockfile);
    assert.match(read(path.join(dir, 'tests', 'Dockerfile')), new RegExp(`^WORKDIR /opt/verifier-deps/server\nRUN ${command}$`, 'm'), lockfile);
    assert.equal(read(path.join(dir, 'tests', 'deps', 'server', lockfile)), '{}\n', lockfile);
  }
});

test('a mongodb-memory-server dependency gets its binary pre-fetched at build time', async (t) => {
  const { dir } = await exported(t, { packageJson: '{"devDependencies":{"mongodb-memory-server":"^9.0.0"}}\n' });
  const docker = read(path.join(dir, 'environment', 'Dockerfile'));
  // Outside /app: the agent's artifact does not carry the binary, and the verifier has its own.
  assert.match(docker, /^ENV MONGOMS_DOWNLOAD_DIR=\/opt\/mongodb-binaries$/m);
  assert.match(docker, /MongoMemoryServer\.create\(\)\.then\(\(s\) => s\.stop\(\)\)/);
  assert.ok(docker.indexOf('ENV MONGOMS_DOWNLOAD_DIR') < docker.indexOf('npm ci'), 'postinstall downloads to the same folder');

  // The verifier installs the same dependencies from the copied base manifests and prefetches there.
  const verifier = read(path.join(dir, 'tests', 'Dockerfile'));
  assert.match(verifier, /^ENV .*MONGOMS_DOWNLOAD_DIR=\/opt\/verifier-deps\/\.mongodb-binaries/m);
  assert.match(verifier, /^WORKDIR \/opt\/verifier-deps\/server\nRUN npm ci\nRUN node -e "require\('mongodb-memory-server'\)\.MongoMemoryServer\.create\(\)\.then\(\(s\) => s\.stop\(\)\)"$/m);
  assert.ok(verifier.indexOf('MONGOMS_DOWNLOAD_DIR') < verifier.indexOf('npm ci'), 'postinstall downloads to the same folder');
  assert.equal(read(path.join(dir, 'tests', 'deps', 'server', 'package.json')), '{"devDependencies":{"mongodb-memory-server":"^9.0.0"}}\n');
});

test('the verifier image installs its own dependencies from the base manifests, readable by the untrusted user', async (t) => {
  const { dir } = await exported(t, { packageJson: '{"name":"base"}\n', baseFiles: { 'server/tsconfig.json': '{}\n', 'server/jest.config.js': 'module.exports = {};\n' } });
  const docker = read(path.join(dir, 'tests', 'Dockerfile'));
  assert.match(docker, /^COPY deps\/ \/opt\/verifier-deps\/$/m);
  assert.match(docker, /^WORKDIR \/opt\/verifier-deps\/server\nRUN npm ci$/m);
  assert.match(docker, /^ENV [\s\S]*HARBOR_DEPS_DIR=\/opt\/verifier-deps/m);
  assert.match(docker, /chmod -R a\+rX \/opt\/verifier-deps/);
  assert.match(docker, /^COPY outcome\.mjs \/tests\/outcome\.mjs$/m);
  assert.doesNotMatch(docker, /MONGOMS/, 'no MongoDB without the dependency');
  // Only what installing needs; the config files are the grader's to hash, not the image's to hold.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tests', 'deps', 'server')).sort(), ['package-lock.json', 'package.json']);
  assert.equal(read(path.join(dir, 'tests', 'deps', 'server', 'package.json')), '{"name":"base"}\n');
  assert.equal(read(path.join(dir, 'tests', 'outcome.mjs')), read(path.join(here, 'escape-replays', 'outcome.mjs')));
});

test('the verifier image runs as root, holds the hidden files, and knows the untrusted ids', async (t) => {
  const { dir } = await exported(t);
  const docker = read(path.join(dir, 'tests', 'Dockerfile'));
  assert.ok(docker.startsWith(`FROM ${PINNED_NODE}\n`));
  assert.match(docker, /HARBOR_UNTRUSTED_UID=65534/);
  assert.match(docker, /HARBOR_UNTRUSTED_GID=65534/);
  assert.match(docker, /^COPY hidden\/ \/tests\/hidden\/$/m);
  assert.match(docker, /^COPY regression\/ \/tests\/regression\/$/m);
  assert.doesNotMatch(docker, /^USER /m);
  assert.match(read(path.join(dir, 'tests', 'test.sh')), /fallback='\{"functional":0,"regression":0,"tests_unchanged":0,"shippable":0\}'/);
});

test('hidden.json lists the hidden and regression files with their hashes, commands and cwds', async (t) => {
  const { dir, report } = await exported(t);
  const spec = JSON.parse(read(path.join(dir, 'tests', 'hidden.json')));
  assert.deepEqual(spec.hidden, [{ path: HIDDEN, sha256: sha(totalIs(3)), argv: ['node', '--test', 'test/total.test.js'], cwd: 'server' }]);
  assert.equal(spec.regression.length, 1);
  assert.equal(spec.regression[0].path, SMOKE);
  assert.equal(spec.regression[0].sha256, sha(read(path.join(dir, 'tests', 'regression', SMOKE))));
  assert.equal(read(path.join(dir, 'tests', 'hidden', HIDDEN)), totalIs(3), 'the fix version');
  // The files the agent must leave alone, and where the verifier gets its dependencies.
  assert.deepEqual(spec.protected, [{ path: 'server/package-lock.json', sha256: sha('{}\n') }, { path: 'server/package.json', sha256: sha('{}\n') }]);
  assert.deepEqual(spec.protected_dirs, ['server']);
  assert.deepEqual(spec.deps, [{ cwd: 'server' }]);
  assert.equal(new RegExp(spec.protected_name).test('jest.config.mjs'), true);
  assert.equal(new RegExp(spec.protected_name).test('total.js'), false);
  // The counts agree everywhere they are stated.
  assert.deepEqual(report.kept, [{ taskId: 'order-refunds', sessionId: 'sess-1', slug: 'order-refunds', repo: 'web', hidden: spec.hidden.length, regression: spec.regression.length }]);
  assert.deepEqual(JSON.parse(read(path.join(dir, '..', '..', 'export-report.json'))).kept, report.kept);
});

test('the agent snapshot holds neither the hidden test nor the regression set copy outside the app', async (t) => {
  const { dir } = await exported(t);
  assert.equal(fs.existsSync(path.join(dir, 'environment', 'app', HIDDEN)), false);
  assert.equal(fs.existsSync(path.join(dir, 'environment', 'tests')), false);
});

test('corpus.json lists the kept task like the other manifests, and the harness accepts the task tree', async (t) => {
  const { dir, p } = await exported(t);
  const manifest = JSON.parse(read(path.join(p.out, 'corpus.json')));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.corpus_id, 'forgekit-escape-replays-v1');
  assert.deepEqual(manifest.tasks, [{ id: 'order-refunds', version: '1.0.0', category: 'escape', difficulty: 'real', task_path: 'local/forgekit-escape-replays-v1/tasks/order-refunds' }]);
  assert.match(manifest.tasks[0].category, /^[a-z][a-z0-9-]*$/);

  const taskRoot = path.join(p.out, 'tasks');
  assert.equal(await assertSafeTaskTree(taskRoot, 'order-refunds'), dir);
  // Not a campaign: the selector's campaign parse reports no episodes.
  const selection = { id: manifest.corpus_id, manifestPath: path.join(p.out, 'corpus.json'), taskRoot, taskRootLocator: 'local/forgekit-escape-replays-v1/tasks' };
  assert.deepEqual(await parseCampaign(selection), { id: manifest.corpus_id, episodes: null });
  // The runner's other checks on a canonical task.
  for (const rel of ['task.toml', 'instruction.md', 'environment/Dockerfile', 'tests']) assert.equal(fs.existsSync(path.join(dir, rel)), true, rel);
});

test('re-exporting replaces the earlier generation instead of mixing with it', async (t) => {
  const { p, dir } = await exported(t);
  fs.mkdirSync(path.join(p.out, 'tasks', 'stale-task'));
  fs.writeFileSync(path.join(p.out, 'tasks', 'stale-task', 'task.toml'), '');
  await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.equal(fs.existsSync(path.join(p.out, 'tasks', 'stale-task')), false);
  assert.equal(fs.existsSync(dir), true);
});

test('the grader scores the reference tree shippable', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(dir, 'solution', 'reference.patch')], { cwd: app, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(grade(t, dir, app), {
    functional: 1, regression: 1, tests_unchanged: 1, shippable: 1,
    requirements_met: 1, requirements_total: 1, regression_met: 1, regression_total: 1,
  });
});

test('solve.sh applies the reference patch to HARBOR_APP_DIR', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const r = spawnSync('sh', [path.join(dir, 'solution', 'solve.sh')], { env: { ...process.env, HARBOR_APP_DIR: app }, encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') return t.skip('no sh on this host');
  assert.equal(r.status, 0, r.stderr);
  // git apply may convert line endings on a host with core.autocrlf; the content is what counts here.
  assert.equal(read(path.join(app, 'server', 'src', 'total.js')).replace(/\r\n/g, '\n'), 'exports.total = () => 3;\n');
  assert.equal(fs.existsSync(path.join(app, HIDDEN)), false, 'the hidden test is not in the solution');
});

test('the grader scores the untouched base not functional', async (t) => {
  const { dir } = await exported(t);
  assert.deepEqual(grade(t, dir, appCopy(t, dir)), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0,
    requirements_met: 0, requirements_total: 1, regression_met: 1, regression_total: 1,
  });
});

test('the grader detects an edited regression file, and still runs the original', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(dir, 'solution', 'reference.patch')], { cwd: app, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  fs.appendFileSync(path.join(app, SMOKE), '// tampered\n');
  const reward = grade(t, dir, app);
  assert.equal(reward.tests_unchanged, 0);
  assert.equal(reward.shippable, 0);
  assert.equal(reward.functional, 1);
  assert.equal(read(path.join(app, SMOKE)), read(path.join(dir, 'tests', 'regression', SMOKE)), 'the verifier restored its copy');
});

test('the grader fails the regression metric when a regression test no longer passes', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  // The agent breaks total() for everyone; its own copy of the tests is irrelevant.
  fs.writeFileSync(path.join(app, 'server', 'src', 'total.js'), 'exports.total = 3;\n');
  const reward = grade(t, dir, app);
  assert.equal(reward.regression, 0);
  assert.equal(reward.regression_met, 0);
  assert.equal(reward.functional, 0);
  assert.equal(reward.shippable, 0);
});

test('the grader will not write through a symlink the agent put where a test folder should be', async (t) => {
  const { dir } = await exported(t);
  const app = appCopy(t, dir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(app, 'server', 'test'), { recursive: true, force: true });
  try {
    fs.symlinkSync(outside, path.join(app, 'server', 'test'), 'junction');
  } catch {
    return t.skip('cannot create a symlink on this host');
  }
  grade(t, dir, app);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the app');
});

test('the grader reports an infrastructure error with an all-zero reward and a nonzero exit', async (t) => {
  const { dir } = await exported(t);
  const rewardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-reward-'));
  t.after(() => fs.rmSync(rewardDir, { recursive: true, force: true }));
  const env = { ...process.env, APP_DIR: appCopy(t, dir), TESTS_DIR: path.join(os.tmpdir(), 'forgekit-no-such-tests'), HARBOR_REWARD_DIR: rewardDir };
  const r = spawnSync(process.execPath, [graderTemplate], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(JSON.parse(read(path.join(rewardDir, 'reward.json'))), {
    functional: 0, regression: 0, tests_unchanged: 0, shippable: 0,
    requirements_met: 0, requirements_total: 0, regression_met: 0, regression_total: 0,
  });
});

test('a re-export clears stale tasks when out holds this corpus\'s report even without a manifest, and touches no other folder', async (t) => {
  const { p } = await exported(t);
  fs.rmSync(path.join(p.out, 'corpus.json'));
  fs.mkdirSync(path.join(p.out, 'tasks', 'stale-task'));
  await exportEscapeReplays({ project: p.root, out: p.out, env: OPT_IN, timeoutSec: 60 });
  assert.equal(fs.existsSync(path.join(p.out, 'tasks', 'stale-task')), false);

  // Another corpus's report, and a folder with no marker at all: left alone.
  for (const marker of [JSON.stringify({ corpus_id: 'someone-elses' }), null]) {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-foreign-out-'));
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    fs.mkdirSync(path.join(other, 'tasks', 'precious'), { recursive: true });
    if (marker) fs.writeFileSync(path.join(other, 'export-report.json'), marker);
    await exportEscapeReplays({ project: p.root, out: other, env: OPT_IN, timeoutSec: 60 });
    assert.equal(fs.existsSync(path.join(other, 'tasks', 'precious')), true, marker ?? 'no marker');
  }
});

test('one per-test timeout serves calibration and the verifier, and the verifier timeout derives from it', async (t) => {
  const { dir, kept } = await exported(t);
  const spec = JSON.parse(read(path.join(dir, 'tests', 'hidden.json')));
  assert.equal(spec.timeout_sec, 60, 'the timeout calibration ran with');
  // 120 s of slack plus the per-test timeout for each of the hidden and regression files (1 + 1).
  assert.match(read(path.join(dir, 'task.toml')), /^\[verifier\]\s*\ntimeout_sec = 240\.0$/m);
  assert.equal(spec.budget_sec, 240 - 60);

  // Left to default, both use the replay's constant.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-default-timeout-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeTask({ out: other, task: kept[0], calibration: kept[0].calibration });
  const byDefault = JSON.parse(read(path.join(other, 'tasks', kept[0].taskId, 'tests', 'hidden.json')));
  assert.equal(byDefault.timeout_sec, DEFAULT_REPLAY_TIMEOUT_SEC);
  assert.match(read(path.join(other, 'tasks', kept[0].taskId, 'task.toml')), new RegExp(`^\\[verifier\\]\\s*\\ntimeout_sec = ${120 + DEFAULT_REPLAY_TIMEOUT_SEC * 2}\\.0$`, 'm'));
});

/** The app tree with the reference patch applied, as a solving agent would leave it. */
function referenceApp(t, dir) {
  const app = appCopy(t, dir);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(dir, 'solution', 'reference.patch')], { cwd: app, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  return app;
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('a test the session and the fix both rewrite stays out of the regression set, so the reference grades shippable', async (t) => {
  const { dir } = await exported(t, {
    baseFiles: { 'server/test/old.test.js': totalIs(1) },
    // Each updates old.test.js to the code of its day: base bytes would fail against the reference.
    sessionFiles: [{ 'server/src/total.js': 'exports.total = () => 2;\n', 'server/test/old.test.js': totalIs(2) }],
    fixes: [{ files: { 'server/src/total.js': 'exports.total = () => 3;\n', 'server/test/old.test.js': totalIs(3), [HIDDEN]: totalIs(3) }, test: HIDDEN }],
  });
  assert.deepEqual(JSON.parse(read(path.join(dir, 'tests', 'hidden.json'))).regression.map((r) => r.path), [SMOKE]);
  const reward = grade(t, dir, referenceApp(t, dir));
  assert.equal(reward.regression, 1);
  assert.equal(reward.shippable, 1);
});

test('code that calls process.exit(0) when loaded does not pass under node --test', async (t) => {
  const { dir } = await exported(t);
  const app = referenceApp(t, dir);
  put(path.join(app, 'server', 'src', 'total.js'), 'process.exit(0);\n');
  const reward = grade(t, dir, app);
  assert.equal(reward.functional, 0);
  assert.equal(reward.requirements_met, 0);
  assert.equal(reward.shippable, 0);
});

test('the grader runs the verifier\'s own dependencies, never the agent\'s node_modules', async (t) => {
  const { dir } = await exported(t);
  const verifierDep = path.join(dir, 'tests', 'deps', 'server', 'node_modules', 'dep', 'index.js');
  const total = "exports.total = () => require('dep').value;\n";

  // The verifier's dependency decides; the agent needs to carry none.
  put(verifierDep, 'exports.value = 3;\n');
  let app = referenceApp(t, dir);
  put(path.join(app, 'server', 'src', 'total.js'), total);
  put(path.join(app, 'server', 'node_modules', 'dep', 'index.js'), 'exports.value = 0;\n');
  assert.equal(grade(t, dir, app).functional, 1, 'the verifier\'s dep, not the agent\'s');

  // A dependency the agent swapped in cannot help.
  put(verifierDep, 'exports.value = 0;\n');
  app = referenceApp(t, dir);
  put(path.join(app, 'server', 'src', 'total.js'), total);
  put(path.join(app, 'server', 'node_modules', 'dep', 'index.js'), 'exports.value = 3;\n');
  assert.equal(grade(t, dir, app).functional, 0, 'the agent\'s dep is not used');

  // Nothing of the agent's is left to find, at the cwd or above it.
  fs.rmSync(path.join(dir, 'tests', 'deps', 'server', 'node_modules'), { recursive: true });
  app = referenceApp(t, dir);
  put(path.join(app, 'server', 'src', 'total.js'), total);
  put(path.join(app, 'server', 'node_modules', 'dep', 'index.js'), 'exports.value = 3;\n');
  put(path.join(app, 'node_modules', 'dep', 'index.js'), 'exports.value = 3;\n');
  assert.equal(grade(t, dir, app).functional, 0, 'no agent node_modules at the cwd or above');
});

test('the grader holds the agent to the manifests, lockfiles and runner configuration', async (t) => {
  const { dir } = await exported(t, { baseFiles: { 'server/tsconfig.json': '{}\n' } });
  const tampering = {
    'edits the manifest (and with it the jest field)': (app) => fs.appendFileSync(path.join(app, 'server', 'package.json'), ' '),
    'edits the lockfile': (app) => fs.appendFileSync(path.join(app, 'server', 'package-lock.json'), ' '),
    'edits tsconfig.json': (app) => fs.appendFileSync(path.join(app, 'server', 'tsconfig.json'), ' '),
    'deletes the lockfile': (app) => fs.rmSync(path.join(app, 'server', 'package-lock.json')),
    'adds a jest config': (app) => put(path.join(app, 'server', 'jest.config.js'), 'module.exports = {};\n'),
    'adds a vitest config': (app) => put(path.join(app, 'server', 'vitest.config.mjs'), 'export default {};\n'),
    'adds a babelrc': (app) => put(path.join(app, 'server', '.babelrc'), '{}\n'),
    'adds a tsconfig variant': (app) => put(path.join(app, 'server', 'tsconfig.build.json'), '{}\n'),
  };
  for (const [name, tamper] of Object.entries(tampering)) {
    const app = referenceApp(t, dir);
    tamper(app);
    const reward = grade(t, dir, app);
    assert.equal(reward.tests_unchanged, 0, name);
    assert.equal(reward.shippable, 0, name);
  }
  // Ordinary source edits are the agent's to make.
  const app = referenceApp(t, dir);
  fs.appendFileSync(path.join(app, 'server', 'src', 'total.js'), '// a comment\n');
  put(path.join(app, 'server', 'README.md'), 'notes\n');
  assert.equal(grade(t, dir, app).tests_unchanged, 1);
});

test('each hidden and regression file is restored right before its own run', async (t) => {
  const { dir } = await exported(t);
  const app = referenceApp(t, dir);
  // Loaded by the hidden test, this code rewrites the regression test that runs after it.
  const planted = "require('node:test')('planted', () => { throw new Error('planted'); });\\n";
  put(
    path.join(app, 'server', 'src', 'total.js'),
    `require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'test', 'smoke.test.js'), "${planted}");\nexports.total = () => 3;\n`,
  );
  const reward = grade(t, dir, app);
  assert.equal(reward.functional, 1);
  assert.equal(reward.regression, 1, 'the regression file was restored just before its run');
  assert.equal(reward.shippable, 1);
});

test('the runner gets a writable HOME, TMPDIR and cache folder outside the app', async (t) => {
  const { dir } = await exported(t);
  const app = referenceApp(t, dir);
  const body = `const fs = require('node:fs');
const path = require('node:path');
test('env', () => {
  const app = path.resolve(__dirname, '..', '..');
  for (const key of ['HOME', 'TMPDIR', 'XDG_CACHE_HOME']) {
    const folder = process.env[key];
    assert.ok(folder, key + ' is set');
    assert.ok(!path.resolve(folder).startsWith(app + path.sep), key + ' is inside the app');
    fs.writeFileSync(path.join(folder, 'probe'), 'x');
  }
});`;
  put(path.join(dir, 'tests', 'hidden', HIDDEN), nodeTest(body));
  assert.equal(grade(t, dir, app).functional, 1);
});

test('as root, the app is read-only to the untrusted user while tests run', { skip: typeof process.getuid !== 'function' || process.getuid() !== 0 }, async (t) => {
  const { dir } = await exported(t);
  const app = referenceApp(t, dir);
  const body = `const fs = require('node:fs');
const path = require('node:path');
test('read-only', () => {
  assert.throws(() => fs.writeFileSync(path.join(__dirname, '..', 'src', 'total.js'), 'x'));
  assert.throws(() => fs.writeFileSync(path.join(__dirname, '..', 'planted.js'), 'x'));
});`;
  put(path.join(dir, 'tests', 'hidden', HIDDEN), nodeTest(body));
  assert.equal(grade(t, dir, app, { HARBOR_UNTRUSTED_UID: '65534', HARBOR_UNTRUSTED_GID: '65534' }).functional, 1);
});

test('the verifier\'s deps hold the tracked .npmrc, .yarnrc and .yarnrc.yml of the cwd and its ancestors, and the grader protects them', async (t) => {
  const { dir } = await exported(t, {
    baseFiles: { '.npmrc': 'a=1\n', 'server/.npmrc': 'b=2\n', 'server/.yarnrc': 'c 3\n', 'server/.yarnrc.yml': 'd: 4\n', 'other/.npmrc': 'elsewhere\n' },
  });
  const deps = (rel) => read(path.join(dir, 'tests', 'deps', rel));
  assert.equal(deps('.npmrc'), 'a=1\n', 'an ancestor, at its matching relative path');
  assert.equal(deps('server/.npmrc'), 'b=2\n');
  assert.equal(deps('server/.yarnrc'), 'c 3\n');
  assert.equal(deps('server/.yarnrc.yml'), 'd: 4\n');
  assert.equal(fs.existsSync(path.join(dir, 'tests', 'deps', 'other')), false, 'a folder that is not an ancestor');
  const spec = JSON.parse(read(path.join(dir, 'tests', 'hidden.json')));
  const protectedPaths = spec.protected.map((f) => f.path);
  for (const rel of ['.npmrc', 'server/.npmrc', 'server/.yarnrc', 'server/.yarnrc.yml']) assert.ok(protectedPaths.includes(rel), rel);
  assert.equal(protectedPaths.includes('other/.npmrc'), false);
  assert.equal(new RegExp(spec.protected_name).test('.yarnrc.yml'), true);

  // Changing or deleting one of them is a change; leaving them alone is not.
  const tampering = {
    'edits the ancestor .npmrc': (app) => fs.appendFileSync(path.join(app, '.npmrc'), ' '),
    'edits .yarnrc.yml': (app) => fs.appendFileSync(path.join(app, 'server', '.yarnrc.yml'), ' '),
    'deletes .yarnrc': (app) => fs.rmSync(path.join(app, 'server', '.yarnrc')),
  };
  for (const [name, tamper] of Object.entries(tampering)) {
    const app = referenceApp(t, dir);
    tamper(app);
    assert.equal(grade(t, dir, app).tests_unchanged, 0, name);
  }
  assert.equal(grade(t, dir, referenceApp(t, dir)).tests_unchanged, 1);
});

test('a new .npmrc in a folder that had none counts as a change, in the cwd and in an ancestor', async (t) => {
  const { dir } = await exported(t);
  for (const rel of ['.npmrc', 'server/.npmrc', 'server/.yarnrc.yml']) {
    const app = referenceApp(t, dir);
    put(path.join(app, rel), 'x=1\n');
    assert.equal(grade(t, dir, app).tests_unchanged, 0, rel);
  }
  // A new package.json in an ancestor is not one of the rc files.
  const app = referenceApp(t, dir);
  put(path.join(app, 'package.json'), '{}\n');
  assert.equal(grade(t, dir, app).tests_unchanged, 1);
});

test('the grader removes every node_modules under the app except the verifier\'s linked ones', async (t) => {
  const { dir } = await exported(t);
  put(path.join(dir, 'tests', 'deps', 'server', 'node_modules', 'dep', 'index.js'), 'exports.value = 0;\n');
  const total = "exports.total = () => require('dep').value;\n";
  // Node resolves 'dep' from server/src through server/src/node_modules first: it is on no cwd path.
  const app = referenceApp(t, dir);
  put(path.join(app, 'server', 'src', 'total.js'), total);
  put(path.join(app, 'server', 'src', 'node_modules', 'dep', 'index.js'), 'exports.value = 3;\n');
  put(path.join(app, 'server', 'vendor', 'deep', 'node_modules', 'x', 'index.js'), 'exports.x = 1;\n');
  assert.equal(grade(t, dir, app).functional, 0, 'the planted nested node_modules is not loaded');
  assert.equal(fs.existsSync(path.join(app, 'server', 'src', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(app, 'server', 'vendor', 'deep', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(app, 'server', 'node_modules', 'dep', 'index.js')), true, 'the linked verifier dependencies stay');
});

test('the grader does not follow a symlinked node_modules when it removes them', async (t) => {
  const { dir } = await exported(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  put(path.join(outside, 'keep.txt'), 'x\n');
  const app = referenceApp(t, dir);
  try {
    fs.symlinkSync(outside, path.join(app, 'server', 'src', 'node_modules'), 'junction');
  } catch {
    return t.skip('cannot create a symlink on this host');
  }
  grade(t, dir, app);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], 'the link was removed, not what it points to');
  assert.equal(fs.existsSync(path.join(app, 'server', 'src', 'node_modules')), false);
});
