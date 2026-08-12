import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run.mjs');
const projectRoot = path.resolve(here, '..', '..');
const testRunsRoot = await mkdtemp(path.join(os.tmpdir(), 'forgekit-run-tests-'));
after(() => rm(testRunsRoot, { recursive: true, force: true }));

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: projectRoot,
      env: { ...process.env, FORGEKIT_EVAL_RUNS_ROOT: testRunsRoot, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const validArgs = [
  '--task', 'node-health-endpoint',
  '--arm', 'both',
  '--repetitions', '2',
  '--concurrency', '2',
  '--progress-interval-seconds', '30',
  '--agent', 'claude-code',
  '--model', 'anthropic/claude-sonnet-4',
  '--forgekit-version', '0.3.37',
];

const campaignArgs = [
  '--corpus', 'forgekit-campaign-v1',
  '--arm', 'both',
  '--repetitions', '1',
  '--concurrency', '1',
  '--agent', 'claude-code',
  '--model', 'anthropic/claude-sonnet-4',
  '--forgekit-version', '0.3.37',
];

function parsePlan(stdout) {
  const plan = JSON.parse(stdout);
  Object.defineProperty(plan, 'runDirectory', {
    value: path.join(testRunsRoot, plan.runId), enumerable: false,
  });
  return plan;
}

function manifestFile(plan, trial) {
  return path.join(plan.runDirectory, trial.manifest);
}

function trialStagedPath(trial) {
  return trial.harborArgv[trial.harborArgv.indexOf('--path') + 1];
}

async function cleanupPlan(plan) {
  if (plan?.runDirectory) await rm(plan.runDirectory, { recursive: true, force: true });
}

async function listRelativeFiles(root) {
  const found = [];
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else found.push(childRelative);
    }
  }
  await visit(root);
  return found;
}

test('dry run stages canonical baseline and Forge arms and writes trial manifests', async (t) => {
  const result = await run([...validArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  assert.equal(plan.dryRun, true);
  assert.match(plan.harnessRevision, /^[a-f0-9]{64}$/);
  assert.equal(plan.trials.length, 4);
  assert.deepEqual(plan.trials.map(({ arm, repetition }) => [arm, repetition]),
    plan.schedule.armOrders.flatMap((armOrder, index) => (
      armOrder.map((arm) => [arm, index + 1])
    )));

  const baseline = path.join(plan.runDirectory, 'arms', 'baseline');
  const forge = path.join(plan.runDirectory, 'arms', 'forge');
  const [canonicalApp, baselineApp, forgeApp] = await Promise.all([
    readFile(path.join(here, 'tasks/node-health-endpoint/environment/app/src/server.mjs'), 'utf8'),
    readFile(path.join(baseline, 'environment/app/src/server.mjs'), 'utf8'),
    readFile(path.join(forge, 'environment/app/src/server.mjs'), 'utf8'),
  ]);
  assert.equal(baselineApp, canonicalApp);
  assert.equal(forgeApp, canonicalApp);

  const baselineDockerfile = await readFile(path.join(baseline, 'environment/Dockerfile'), 'utf8');
  const forgeDockerfile = await readFile(path.join(forge, 'environment/Dockerfile'), 'utf8');
  assert.doesNotMatch(baselineDockerfile, /npm install .*@izkac\/forgekit/);
  assert.match(forgeDockerfile, /RUN npm install --global @izkac\/forgekit@0\.3\.37/);
  assert.doesNotMatch(forgeDockerfile, /FORGEKIT_INSTALL_MARKER/);

  const baselineInstruction = await readFile(path.join(baseline, 'instruction.md'), 'utf8');
  const forgeInstruction = await readFile(path.join(forge, 'instruction.md'), 'utf8');
  assert.match(baselineInstruction, /Evaluation arm: baseline/);
  assert.doesNotMatch(baselineInstruction, /Forge workflow/i);
  assert.match(forgeInstruction, /Evaluation arm: forge/);
  assert.match(forgeInstruction, /Forge workflow/);

  for (const trial of plan.trials) {
    assert.deepEqual(trial.harborArgv.slice(0, 2), ['run', '--path']);
    assert.equal(trial.harborArgv[trial.harborArgv.indexOf('--agent') + 1], 'claude-code');
    assert.equal(trial.harborArgv[trial.harborArgv.indexOf('--model') + 1], 'anthropic/claude-sonnet-4');
    const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.task, 'node-health-endpoint');
    assert.equal(manifest.arm, trial.arm);
    assert.equal(manifest.trialId, trial.trialId);
    assert.equal(manifest.forgekitVersion, '0.3.37');
    assert.equal(manifest.settings.concurrency, 2);
    assert.deepEqual(manifest.harbor.argv, trial.harborArgv);
    assert.equal(manifest.harbor.version, null);
    assert.equal(manifest.harbor.versionSource, 'not-probed-dry-run');
    assert.match(manifest.images.agent, /node:22-bookworm@sha256:[a-f0-9]{64}/);
    assert.match(manifest.images.verifier, /node:22-bookworm@sha256:[a-f0-9]{64}/);
    assert.equal(Object.keys(manifest).some((key) => /key|token|secret|credential/i.test(key)), false);
    assert.equal(JSON.stringify(manifest).includes(testRunsRoot), false);
    assert.equal(JSON.stringify(manifest).includes(projectRoot), false);
  }
});

test('dry run stages an immutable local tarball only in the Forge arm', async (t) => {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit local tarball ; '));
  const sourceTarball = path.join(sourceDirectory, 'operator named $(unsafe).tgz');
  const payload = Buffer.from('local-forgekit-payload\0with-binary-bytes');
  await writeFile(sourceTarball, payload);
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));

  const args = validArgs.filter((value, index) => (
    value !== '--forgekit-version' && validArgs[index - 1] !== '--forgekit-version'
  ));
  args.push('--forgekit-tarball', sourceTarball, '--dry-run');
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  const digest = createHash('sha256').update(payload).digest('hex');
  const stagedFilename = `forgekit-treatment-${digest}.tgz`;
  const treatment = {
    kind: 'local-tarball',
    sha256: digest,
    byteSize: payload.length,
    stagedFilename,
  };
  assert.deepEqual(plan.settings.forgekitTreatment, treatment);
  assert.equal(JSON.stringify(plan).includes(sourceTarball), false);
  assert.equal(result.stdout.includes(testRunsRoot), false, 'serialized plan must use portable run-relative locators');
  assert.equal(JSON.stringify(plan).includes(testRunsRoot), false, 'plan must use portable run-relative locators');
  assert.equal(JSON.stringify(plan).includes(projectRoot), false, 'plan must not disclose the checkout path');

  const baselineEnvironment = path.join(plan.runDirectory, 'arms', 'baseline', 'environment');
  const forgeEnvironment = path.join(plan.runDirectory, 'arms', 'forge', 'environment');
  assert.equal((await readdir(baselineEnvironment)).some((name) => name.endsWith('.tgz')), false);
  assert.deepEqual(await readFile(path.join(forgeEnvironment, stagedFilename)), payload);

  const baselineDockerfile = await readFile(path.join(baselineEnvironment, 'Dockerfile'), 'utf8');
  const forgeDockerfile = await readFile(path.join(forgeEnvironment, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(baselineDockerfile, /forgekit-treatment|npm install .*forgekit/i);
  assert.match(forgeDockerfile, new RegExp(`COPY ${stagedFilename} /tmp/forgekit-treatment\\.tgz`));
  assert.match(forgeDockerfile, new RegExp(`${digest}  /tmp/forgekit-treatment\\.tgz`));
  assert.match(forgeDockerfile, /sha256sum --check --strict/);
  assert.match(forgeDockerfile, /npm install --global --ignore-scripts --no-audit --no-fund \/tmp\/forgekit-treatment\.tgz/);
  assert.doesNotMatch(forgeDockerfile, /operator named|FORGEKIT_INSTALL_MARKER/);

  for (const trial of plan.trials) {
    const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
    assert.equal(manifest.forgekitVersion, null);
    assert.deepEqual(manifest.forgekitTreatment, treatment);
    assert.equal(JSON.stringify(manifest).includes(sourceTarball), false);
  }

  const secondTarball = path.join(sourceDirectory, 'same payload elsewhere.tgz');
  await writeFile(secondTarball, payload);
  const secondArgs = args.map((value) => value === sourceTarball ? secondTarball : value);
  const secondResult = await run(secondArgs);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const secondPlan = parsePlan(secondResult.stdout);
  t.after(() => cleanupPlan(secondPlan));
  assert.equal(secondPlan.runId, plan.runId, 'dry-run identity must depend on payload bytes, not host path');
});

test('local tarball selection fails closed before creating a run', async (t) => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-tarball-validation-'));
  const tarball = path.join(fixtureDirectory, 'forgekit.tgz');
  await writeFile(tarball, 'payload');
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const isolatedRuns = await mkdtemp(path.join(os.tmpdir(), 'forgekit-tarball-invalid-runs-'));
  t.after(() => rm(isolatedRuns, { recursive: true, force: true }));

  const withoutVersion = validArgs.filter((value, index) => (
    value !== '--forgekit-version' && validArgs[index - 1] !== '--forgekit-version'
  ));
  const cases = [
    [withoutVersion, 'exactly one of --forgekit-version and --forgekit-tarball is required'],
    [[...validArgs, '--forgekit-tarball', tarball], 'exactly one of --forgekit-version and --forgekit-tarball is required'],
    [[...withoutVersion, '--forgekit-tarball', path.join(fixtureDirectory, 'missing.tgz')], 'forgekit-tarball must be a readable regular file'],
    [[...withoutVersion, '--forgekit-tarball', fixtureDirectory], 'forgekit-tarball must be a readable regular file'],
  ];
  for (const [args, message] of cases) {
    const result = await run([...args, '--dry-run'], {
      env: { FORGEKIT_EVAL_RUNS_ROOT: isolatedRuns },
    });
    assert.notEqual(result.code, 0, `expected failure for ${args.join(' ')}`);
    assert.match(result.stderr, new RegExp(message));
  }
  assert.deepEqual(await readdir(isolatedRuns), []);
});

test('rejects invalid input before creating a run', async () => {
  const cases = [
    [['--arm', 'control'], 'arm must be one of'],
    [['--repetitions', '0'], 'repetitions must be a positive integer'],
    [['--repetitions', '1.5'], 'repetitions must be a positive integer'],
    [['--concurrency', '-1'], 'concurrency must be a positive integer'],
    [['--progress-interval-seconds', '-1'], 'progress-interval-seconds must be an integer between 0 and 86400'],
    [['--progress-interval-seconds', '1.5'], 'progress-interval-seconds must be an integer between 0 and 86400'],
    [['--progress-interval-seconds', '86401'], 'progress-interval-seconds must be an integer between 0 and 86400'],
    [['--forgekit-version', 'latest'], 'forgekit-version must be a published semantic version'],
    [['--forgekit-version', '1.2.3; touch pwned'], 'forgekit-version must be a published semantic version'],
    [['--agent', '--malicious'], '--agent requires a value'],
    [['--model', ''], 'model must be a non-empty identifier'],
    [['--task', '../node-health-endpoint'], 'task must be a safe task id'],
  ];
  const isolatedRuns = await mkdtemp(path.join(os.tmpdir(), 'forgekit-invalid-runs-'));
  for (const [replacement, message] of cases) {
    const args = [...validArgs];
    const option = replacement[0];
    args[args.indexOf(option) + 1] = replacement[1];
    const result = await run([...args, '--dry-run'], { env: { FORGEKIT_EVAL_RUNS_ROOT: isolatedRuns } });
    assert.notEqual(result.code, 0, `${option}=${replacement[1]} should fail`);
    assert.match(result.stderr, new RegExp(message));
  }
  assert.deepEqual(await readdir(isolatedRuns), []);
});

test('real run invokes Harbor directly with the documented argv', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-bin '));
  const capture = path.join(bin, 'captured argv.jsonl');
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('0.20.0\\n');
  process.exit(0);
}
appendFileSync(process.env.HARBOR_CAPTURE_FILE, JSON.stringify(args) + '\\n');
const jobs = args[args.indexOf('--jobs-dir') + 1];
const job = path.join(jobs, 'fake-job');
const output = path.join(job, 'fake-trial');
mkdirSync(path.join(output, 'verifier'), { recursive: true });
mkdirSync(path.join(output, 'artifacts', 'app', '.forge'), { recursive: true });
writeFileSync(path.join(output, 'verifier', 'reward.json'), JSON.stringify({ functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }));
writeFileSync(path.join(output, 'result.json'), JSON.stringify({
  started_at: '2026-08-09T00:00:00.000Z',
  finished_at: '2026-08-09T00:00:01.500Z',
  agent_info: {
    name: 'claude-code', version: 'S3CR3T', workspace: process.cwd(), secret: 'AGENT-INFO-SECRET',
    model_info: { name: 'claude-sonnet-4', provider: 'anthropic', prompt: 'PRIVATE-PROMPT' }
  },
  agent_result: { n_input_tokens: 10, n_output_tokens: 5, cost_usd: 0.01 }
}));
writeFileSync(path.join(job, 'result.json'), JSON.stringify({ stats: { n_retries: 2 } }));
writeFileSync(path.join(output, 'artifacts', 'app', '.forge', 'scorecard.json'), '{}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const args = [...validArgs];
  args[args.indexOf('--arm') + 1] = 'baseline';
  args[args.indexOf('--repetitions') + 1] = '1';
  const result = await run(args, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HARBOR_CAPTURE_FILE: capture },
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  const captured = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured, [plan.trials[0].harborArgv]);
  assert.equal(plan.trials[0].harborArgv[plan.trials[0].harborArgv.indexOf('--path') + 1], 'arms/baseline');
  assert.equal(plan.trials[0].status, 'verified');
  assert.equal(captured[0].includes('--n-concurrent'), true);
  assert.equal(captured[0][captured[0].indexOf('--n-concurrent') + 1], '1');
  assert.equal(captured[0].includes('--artifact'), false);
  const manifest = JSON.parse(await readFile(manifestFile(plan, plan.trials[0]), 'utf8'));
  assert.equal(manifest.harbor.version, '0.20.0');
  assert.equal(manifest.status, 'verified');
  assert.deepEqual(manifest.resolvedAgent, {
    name: 'claude-code',
    version: null,
    model_info: { name: 'claude-sonnet-4', provider: 'anthropic' },
  });
  assert.equal(JSON.stringify(manifest).includes('AGENT-INFO-SECRET'), false);
  assert.equal(JSON.stringify(manifest).includes('PRIVATE-PROMPT'), false);
  assert.equal(JSON.stringify(manifest).includes(testRunsRoot), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(plan.runDirectory, manifest.normalizedResult), 'utf8')).outcome, {
    functional: 1, regression: 1, tests_unchanged: 1, shippable: 1,
  });
  const normalized = JSON.parse(await readFile(path.join(plan.runDirectory, manifest.normalizedResult), 'utf8'));
  assert.equal(normalized.instrumentation.harbor.input_tokens, 10);
  assert.equal(normalized.instrumentation.harbor.retries, 2);
});

test('Forge real run collects Forge artifacts and normalizes them as secondary telemetry', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-forge-bin '));
  const capture = path.join(bin, 'captured.jsonl');
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
appendFileSync(process.env.HARBOR_CAPTURE_FILE, JSON.stringify(args) + '\\n');
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
const output = path.join(job, 'trial');
mkdirSync(path.join(output, 'verifier'), { recursive: true });
mkdirSync(path.join(output, 'artifacts', '.forge'), { recursive: true });
writeFileSync(path.join(output, 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
writeFileSync(path.join(output, 'result.json'), '{"agent_result":{"n_input_tokens":3}}');
writeFileSync(path.join(job, 'result.json'), '{"stats":{"n_retries":1}}');
writeFileSync(path.join(output, 'artifacts', '.forge', 'session.json'), '{}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));
  const args = [...validArgs];
  args[args.indexOf('--arm') + 1] = 'forge';
  args[args.indexOf('--repetitions') + 1] = '1';
  const result = await run(args, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HARBOR_CAPTURE_FILE: capture } });
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  const invoked = JSON.parse((await readFile(capture, 'utf8')).trim());
  assert.equal(invoked[invoked.indexOf('--artifact') + 1], '/app/.forge');
  const manifest = JSON.parse(await readFile(manifestFile(plan, plan.trials[0]), 'utf8'));
  const normalized = JSON.parse(await readFile(path.join(plan.runDirectory, manifest.normalizedResult), 'utf8'));
  assert.equal(normalized.instrumentation.available, true);
  assert.equal(normalized.instrumentation.forge.artifactPath, undefined);
  const artifactLocator = normalized.instrumentation.forge.artifactLocator;
  assert.match(artifactLocator, /(?:^|\/)artifacts\/(?:app\/)?\.forge$/);
  assert.equal(path.isAbsolute(artifactLocator), false);
  assert.equal(artifactLocator.split('/').includes('..'), false);
  const trialOutputRoot = path.join(plan.runDirectory, 'trials', plan.trials[0].trialId, 'harbor');
  assert.equal((await stat(path.join(trialOutputRoot, artifactLocator))).isDirectory(), true);
  assert.equal(JSON.stringify(normalized).includes(testRunsRoot), false);
  assert.equal(JSON.stringify(normalized).includes(projectRoot), false);
});


test('rejects an agent-controlled Forge artifact named reward.json', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-untrusted-reward-'));
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
mkdirSync(path.join(job, 'trial', 'artifacts', 'app', '.forge', 'verifier'), { recursive: true });
writeFileSync(path.join(job, 'trial', 'artifacts', 'app', '.forge', 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));
  const args = [...validArgs];
  args[args.indexOf('--arm') + 1] = 'forge';
  args[args.indexOf('--repetitions') + 1] = '1';
  const result = await run(args, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /verifier reward\.json/);
});


test('seeded paired schedules replay deterministically and persist exact counterbalance metadata', async (t) => {
  const seededArgs = [...validArgs, '--seed', 'replay-seed_2026', '--dry-run'];
  const firstResult = await run(seededArgs);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  const first = parsePlan(firstResult.stdout);
  t.after(() => cleanupPlan(first));

  const persisted = JSON.parse(await readFile(path.join(first.runDirectory, 'plan.json'), 'utf8'));
  assert.deepEqual(persisted, first);
  assert.equal(first.seed, 'replay-seed_2026');
  assert.equal(first.settings.seed, first.seed);
  assert.equal(first.category, 'feature');
  assert.match(first.corpus.id, /^[a-z0-9-]+$/);
  assert.match(first.corpus.revision, /^[a-f0-9]{64}$/);
  assert.match(first.schedule.startHash, /^[a-f0-9]{64}$/);
  assert.ok(['baseline', 'forge'].includes(first.schedule.startingArm));
  assert.deepEqual(first.schedule.firstArmCounts, { baseline: 1, forge: 1 });
  assert.deepEqual(first.schedule.imbalance, {
    present: false,
    firstPositionDifference: 0,
    favoredArm: null,
  });

  const byRepetition = Map.groupBy(first.trials, (trial) => trial.repetition);
  assert.deepEqual([...byRepetition.values()].map((pair) => pair.map((trial) => trial.arm)), [
    first.schedule.armOrders[0],
    first.schedule.armOrders[1],
  ]);
  assert.deepEqual(first.schedule.armOrders[1], [...first.schedule.armOrders[0]].reverse());
  assert.deepEqual(first.trials.map((trial) => trial.scheduleIndex), [1, 2, 3, 4]);
  assert.deepEqual(first.trials.map((trial) => trial.executionIndex), [null, null, null, null]);

  for (const trial of first.trials) {
    const manifest = JSON.parse(await readFile(manifestFile(first, trial), 'utf8'));
    assert.equal(manifest.seed, first.settings.seed);
    assert.equal(manifest.category, 'feature');
    assert.deepEqual(manifest.corpus, first.corpus);
    assert.equal(manifest.scheduleIndex, trial.scheduleIndex);
    assert.equal(manifest.executionIndex, null);
    assert.deepEqual(manifest.armOrder, first.schedule.armOrders[trial.repetition - 1]);
    assert.equal(manifest.armOrdinal, manifest.armOrder.indexOf(manifest.arm) + 1);
    assert.equal(manifest.startedAt, null);
    assert.equal(manifest.finishedAt, null);
  }

  const secondResult = await run(seededArgs);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const second = parsePlan(secondResult.stdout);
  t.after(() => cleanupPlan(second));
  assert.equal(second.runId, first.runId);
  assert.deepEqual(second.schedule, first.schedule);
  assert.deepEqual(
    second.trials.map(({ arm, repetition, scheduleIndex, armOrder, armOrdinal }) => (
      { arm, repetition, scheduleIndex, armOrder, armOrdinal }
    )),
    first.trials.map(({ arm, repetition, scheduleIndex, armOrder, armOrdinal }) => (
      { arm, repetition, scheduleIndex, armOrder, armOrdinal }
    )),
  );
});

test('odd paired schedules disclose their one-first-position imbalance', async (t) => {
  const args = [...validArgs, '--seed', 'odd-seed', '--dry-run'];
  args[args.indexOf('--repetitions') + 1] = '3';
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  const otherArm = plan.schedule.startingArm === 'baseline' ? 'forge' : 'baseline';
  assert.deepEqual(plan.schedule.firstArmCounts, {
    [plan.schedule.startingArm]: 2,
    [otherArm]: 1,
  });
  assert.deepEqual(plan.schedule.imbalance, {
    present: true,
    firstPositionDifference: 1,
    favoredArm: plan.schedule.startingArm,
  });
  assert.deepEqual(plan.schedule.armOrders, [
    [plan.schedule.startingArm, otherArm],
    [otherArm, plan.schedule.startingArm],
    [plan.schedule.startingArm, otherArm],
  ]);
});

test('single-arm schedules remain one ordinary trial per repetition', async (t) => {
  const args = [...validArgs, '--seed', 'single-arm-seed', '--dry-run'];
  args[args.indexOf('--arm') + 1] = 'forge';
  args[args.indexOf('--repetitions') + 1] = '3';
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  assert.equal(plan.schedule.strategy, 'single-arm');
  assert.equal(plan.schedule.startingArm, null);
  assert.deepEqual(plan.schedule.armOrders, [['forge'], ['forge'], ['forge']]);
  assert.deepEqual(plan.schedule.firstArmCounts, { baseline: 0, forge: 3 });
  assert.equal(plan.schedule.imbalance, null);
  assert.deepEqual(plan.trials.map((trial) => [trial.arm, trial.repetition, trial.armOrdinal]), [
    ['forge', 1, 1], ['forge', 2, 1], ['forge', 3, 1],
  ]);
});

test('rejects unsafe seeds before creating a run', async (t) => {
  const isolatedRuns = await mkdtemp(path.join(os.tmpdir(), 'forgekit-invalid-seed-runs-'));
  t.after(() => rm(isolatedRuns, { recursive: true, force: true }));
  for (const seed of ['', '../escape', 'contains space', 'semi;colon', 'x'.repeat(129)]) {
    const result = await run([...validArgs, '--seed', seed, '--dry-run'], {
      env: { FORGEKIT_EVAL_RUNS_ROOT: isolatedRuns },
    });
    assert.notEqual(result.code, 0, `seed ${JSON.stringify(seed)} should fail`);
    assert.match(result.stderr, /seed must be a safe identifier/);
  }
  assert.deepEqual(await readdir(isolatedRuns), []);
});

test('paired execution serializes each pair, records actual order, and continues after failures', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-pair-bin-'));
  const capture = path.join(bin, 'events.jsonl');
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const jobName = args[args.indexOf('--job-name') + 1];
const event = (name) => appendFileSync(process.env.HARBOR_CAPTURE_FILE, JSON.stringify({ name, jobName, at: Date.now() }) + '\\n');
event('start');
await new Promise((resolve) => setTimeout(resolve, 40));
if (jobName.includes('-baseline-')) { event('end'); process.exit(9); }
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
mkdirSync(path.join(job, 'trial', 'verifier'), { recursive: true });
writeFileSync(path.join(job, 'trial', 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
event('end');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const args = [...validArgs, '--seed', 'pair-failure-seed'];
  args[args.indexOf('--repetitions') + 1] = '3';
  args[args.indexOf('--concurrency') + 1] = '2';
  const result = await run(args, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HARBOR_CAPTURE_FILE: capture },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /3 trial\(s\) failed/);
  assert.match(result.stderr, /event=trial-failed arm=baseline/);
  assert.match(result.stderr, /event=run-completed status=completed-with-failures verified=3 failed=3/);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  assert.equal(plan.status, 'completed-with-failures');
  assert.equal(plan.trials.length, 6);
  assert.deepEqual(plan.trials.map((trial) => trial.status).sort(), [
    'failed', 'failed', 'failed', 'verified', 'verified', 'verified',
  ]);
  assert.deepEqual(
    [...plan.trials].sort((left, right) => left.executionIndex - right.executionIndex)
      .map((trial) => trial.executionIndex),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(plan.trials.every((trial) => trial.startedAt && trial.finishedAt));
  assert.deepEqual(JSON.parse(await readFile(path.join(plan.runDirectory, 'plan.json'), 'utf8')), plan);

  const events = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const trials = plan.trials.filter((trial) => trial.repetition === repetition);
    assert.deepEqual(trials.map((trial) => trial.arm), trials[0].armOrder);
    const firstEnd = events.findIndex((event) => event.name === 'end' && event.jobName === trials[0].trialId);
    const secondStart = events.findIndex((event) => event.name === 'start' && event.jobName === trials[1].trialId);
    assert.ok(firstEnd >= 0 && secondStart > firstEnd, `repetition ${repetition} arms must execute serially`);
    for (const trial of trials) {
      const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
      assert.equal(manifest.executionIndex, trial.executionIndex);
      assert.equal(manifest.startedAt, trial.startedAt);
      assert.equal(manifest.finishedAt, trial.finishedAt);
      assert.equal(manifest.status, trial.status);
    }
  }
});


test('rejects tasks outside the versioned corpus before creating a run', async (t) => {
  const isolatedRuns = await mkdtemp(path.join(os.tmpdir(), 'forgekit-unlisted-task-runs-'));
  t.after(() => rm(isolatedRuns, { recursive: true, force: true }));
  const args = [...validArgs];
  args[args.indexOf('--task') + 1] = 'unlisted-safe-task';
  const result = await run([...args, '--dry-run'], {
    env: { FORGEKIT_EVAL_RUNS_ROOT: isolatedRuns },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not listed exactly once in corpus\.json/);
  assert.deepEqual(await readdir(isolatedRuns), []);
});


test('long real trial emits sanitized lifecycle heartbeats on stderr while stdout stays JSON', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-progress-bin-'));
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
await new Promise((resolve) => setTimeout(resolve, 1200));
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
const output = path.join(job, 'trial');
mkdirSync(path.join(output, 'verifier'), { recursive: true });
writeFileSync(path.join(output, 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
writeFileSync(path.join(output, 'result.json'), '{}');
writeFileSync(path.join(job, 'result.json'), '{}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const args = [...validArgs];
  args[args.indexOf('--arm') + 1] = 'baseline';
  args[args.indexOf('--repetitions') + 1] = '1';
  args[args.indexOf('--progress-interval-seconds') + 1] = '1';
  const result = await run(args, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  assert.equal(plan.status, 'completed');
  assert.equal(plan.trials[0].status, 'verified');
  assert.match(result.stderr, /\[eval-progress] run=[^ ]+ event=run-start task=node-health-endpoint trials=1/);
  assert.match(result.stderr, /event=trial-start arm=baseline ordinal=1\/1/);
  assert.match(result.stderr, /event=trial-heartbeat arm=baseline status=running elapsedSeconds=1/);
  assert.match(result.stderr, /event=trial-verified arm=baseline elapsedSeconds=/);
  assert.match(result.stderr, /event=run-completed status=completed verified=1 failed=0 elapsedSeconds=/);
  assert.equal(result.stderr.includes(testRunsRoot), false);
  assert.equal(result.stderr.includes(projectRoot), false);

  const noHeartbeatArgs = [...args];
  noHeartbeatArgs[noHeartbeatArgs.indexOf('--progress-interval-seconds') + 1] = '0';
  const noHeartbeat = await run(noHeartbeatArgs, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(noHeartbeat.code, 0, noHeartbeat.stderr);
  const noHeartbeatPlan = parsePlan(noHeartbeat.stdout);
  t.after(() => cleanupPlan(noHeartbeatPlan));
  assert.doesNotMatch(noHeartbeat.stderr, /event=trial-heartbeat/);
  assert.match(noHeartbeat.stderr, /event=trial-start/);
  assert.match(noHeartbeat.stderr, /event=trial-verified/);
  assert.match(noHeartbeat.stderr, /event=run-completed/);

  const concurrentArgs = [...args];
  concurrentArgs[concurrentArgs.indexOf('--repetitions') + 1] = '2';
  concurrentArgs[concurrentArgs.indexOf('--concurrency') + 1] = '2';
  const concurrent = await run(concurrentArgs, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(concurrent.code, 0, concurrent.stderr);
  const concurrentPlan = parsePlan(concurrent.stdout);
  t.after(() => cleanupPlan(concurrentPlan));
  const heartbeatTrials = [...concurrent.stderr.matchAll(
    /event=trial-heartbeat arm=baseline status=running elapsedSeconds=\d+ trial=([^\s]+)/g,
  )].map((match) => match[1]);
  assert.equal(new Set(heartbeatTrials).size, 2);
});


test('failed normalization keeps paths and malformed content out of structured output', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-private-error-bin-'));
  const fakeHarbor = path.join(bin, 'harbor');
  const secretMarker = 'S3CR3T';
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
const output = path.join(job, 'trial');
mkdirSync(path.join(output, 'verifier'), { recursive: true });
writeFileSync(path.join(output, 'verifier', 'reward.json'), '${secretMarker}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const args = [...validArgs];
  args[args.indexOf('--arm') + 1] = 'baseline';
  args[args.indexOf('--repetitions') + 1] = '1';
  const result = await run(args, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.notEqual(result.code, 0);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  const persisted = await readFile(path.join(plan.runDirectory, 'plan.json'), 'utf8');
  const manifest = await readFile(manifestFile(plan, plan.trials[0]), 'utf8');
  const publicOutput = `${result.stdout}
${result.stderr}
${persisted}
${manifest}`;
  assert.equal(publicOutput.includes(secretMarker), false);
  assert.equal(publicOutput.includes(testRunsRoot), false);
  assert.equal(publicOutput.includes(projectRoot), false);
  assert.equal(plan.trials[0].error, 'result normalization failed; inspect trial-local normalizer.stderr.log');
  assert.equal(JSON.parse(manifest).error, plan.trials[0].error);
  const privateDiagnostic = await readFile(
    path.join(plan.runDirectory, 'trials', plan.trials[0].trialId, 'normalizer.stderr.log'),
    'utf8',
  );
  assert.match(privateDiagnostic, /S3CR3T/);
  assert.equal(privateDiagnostic.includes(testRunsRoot), true);
});


test('untrusted Harbor version output is rejected without serialization', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-version-bin-'));
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('harbor 0.20.0 VERSION-S3CR3T ' + process.env.FORGEKIT_EVAL_RUNS_ROOT);
  process.exit(0);
}
process.exit(9);
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));
  const result = await run(validArgs, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Harbor version probe returned unrecognized output/);
  assert.equal(result.stderr.includes('VERSION-S3CR3T'), false);
  assert.equal(result.stderr.includes(testRunsRoot), false);
});

test('omitted and explicit v1 corpus selection use the frozen legacy manifest and task root', async (t) => {
  const omittedResult = await run([...validArgs, '--dry-run']);
  assert.equal(omittedResult.code, 0, omittedResult.stderr);
  const omitted = parsePlan(omittedResult.stdout);
  t.after(() => cleanupPlan(omitted));

  const explicitResult = await run([...validArgs, '--corpus', 'forgekit-held-out-v1', '--dry-run']);
  assert.equal(explicitResult.code, 0, explicitResult.stderr);
  const explicit = parsePlan(explicitResult.stdout);
  t.after(() => cleanupPlan(explicit));

  assert.equal(explicit.runId, omitted.runId);
  assert.equal(omitted.runId, 'dry-run-3c61176c4236', 'omitted selector must preserve the v1 dry-run identity');
  assert.deepEqual(explicit.corpus, omitted.corpus);
  assert.equal(explicit.corpus.id, 'forgekit-held-out-v1');
  assert.equal(explicit.taskRevision, omitted.taskRevision);
  assert.equal(explicit.taskVersion, '1.0.0');
  assert.deepEqual(explicit.arms, omitted.arms);
  for (const trial of explicit.trials) {
    const manifest = JSON.parse(await readFile(manifestFile(explicit, trial), 'utf8'));
    assert.deepEqual(manifest.corpus, explicit.corpus);
    assert.equal(manifest.taskVersion, explicit.taskVersion);
    assert.equal(manifest.canonicalTask, 'tasks/node-health-endpoint');
  }
});

test('rejects unknown and path-like corpus selectors before creating a run', async (t) => {
  const isolatedRuns = await mkdtemp(path.join(os.tmpdir(), 'forgekit-invalid-corpus-runs-'));
  t.after(() => rm(isolatedRuns, { recursive: true, force: true }));
  const cases = [
    ['unknown-corpus', /unknown corpus: unknown-corpus/],
    ['../forgekit-hard-v2', /corpus must be a safe corpus id/],
    ['/tmp/corpus.json', /corpus must be a safe corpus id/],
    ['forgekit-hard-v2.json', /corpus must be a safe corpus id/],
  ];
  for (const [corpus, expected] of cases) {
    const result = await run([...validArgs, '--corpus', corpus, '--dry-run'], {
      env: { FORGEKIT_EVAL_RUNS_ROOT: isolatedRuns },
    });
    assert.notEqual(result.code, 0, `corpus ${corpus} should fail`);
    assert.match(result.stderr, expected);
  }
  assert.deepEqual(await readdir(isolatedRuns), []);
});

test('explicit hard-v2 selection stages only its allowlisted root and records complete provenance', async (t) => {
  const args = [...validArgs, '--corpus', 'forgekit-hard-v2', '--dry-run'];
  args[args.indexOf('--task') + 1] = 'reservation-confirmation-race';
  args[args.indexOf('--repetitions') + 1] = '1';
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  assert.equal(plan.task, 'reservation-confirmation-race');
  assert.equal(plan.taskVersion, '1.0.1');
  assert.equal(plan.category, 'bug');
  assert.equal(plan.corpus.id, 'forgekit-hard-v2');
  assert.equal(plan.corpus.schemaVersion, 1);
  assert.match(plan.corpus.revision, /^[a-f0-9]{64}$/);
  assert.match(plan.taskRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(plan.runId, '');

  for (const arm of plan.arms) {
    assert.equal(
      await readFile(path.join(plan.runDirectory, arm.stagedTask, 'environment/app/src/confirmation-service.mjs'), 'utf8')
        .then((source) => source.length > 0),
      true,
    );
  }
  for (const trial of plan.trials) {
    const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
    assert.deepEqual(manifest.corpus, plan.corpus);
    assert.equal(manifest.taskRevision, plan.taskRevision);
    assert.equal(manifest.taskVersion, plan.taskVersion);
    assert.equal(manifest.canonicalTask, 'tasks/forgekit-hard-v2/reservation-confirmation-race');
  }
});

test('campaign dry-run plans one trial per episode per arm in declared order', async (t) => {
  const declared = JSON.parse(await readFile(path.join(here, 'corpora/forgekit-campaign-v1.json'), 'utf8'));
  const result = await run([...campaignArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  const expectedTrialCount = declared.episodes.length * plan.schedule.armOrders[0].length;
  assert.equal(plan.trials.length, expectedTrialCount);
  assert.equal(plan.campaign.id, declared.corpus_id);
  assert.deepEqual(
    plan.campaign.episodes.map((episode) => ({ id: episode.id, index: episode.index })),
    declared.episodes.map((episode) => ({ id: episode.id, index: episode.index })),
  );

  const expected = plan.schedule.armOrders[0].flatMap((arm) => (
    declared.episodes.map((episode) => ({
      arm,
      episodeId: episode.id,
      episodeIndex: episode.index,
      repetition: 1,
    }))
  ));
  assert.deepEqual(
    plan.trials.map((trial) => ({
      arm: trial.arm,
      episodeId: trial.episodeId,
      episodeIndex: trial.episodeIndex,
      repetition: trial.repetition,
    })),
    expected,
  );

  const trialIds = new Set(plan.trials.map((trial) => trial.trialId));
  assert.equal(trialIds.size, plan.trials.length);

  for (const trial of plan.trials) {
    const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
    assert.equal(manifest.episodeId, trial.episodeId);
    assert.equal(manifest.episodeIndex, trial.episodeIndex);
    assert.equal(manifest.trialId, trial.trialId);
    assert.match(trial.trialId, new RegExp(`-${trial.arm}-`));
    assert.equal(trial.harborArgv[trial.harborArgv.indexOf('--job-name') + 1], trial.trialId);
    assert.equal(manifest.harbor.argv[manifest.harbor.argv.indexOf('--job-name') + 1], trial.trialId);
  }
});

test('rejects --task when the selected corpus is a campaign', async () => {
  const result = await run([...campaignArgs, '--task', 'episode-01', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--task is not valid for a campaign corpus/);
});

test('non-campaign corpora still require --task', async () => {
  const withoutTask = validArgs.filter((value, index) => (
    value !== '--task' && validArgs[index - 1] !== '--task'
  ));
  const result = await run([...withoutTask, '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--task is required/);
});

test('campaign episodes execute in declared order and never overlap within an arm', async (t) => {
  const declared = JSON.parse(await readFile(path.join(here, 'corpora/forgekit-campaign-v1.json'), 'utf8'));
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-campaign-order-'));
  const capture = path.join(bin, 'events.jsonl');
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const jobName = args[args.indexOf('--job-name') + 1];
const event = (name) => appendFileSync(process.env.HARBOR_CAPTURE_FILE, JSON.stringify({ name, jobName, at: Date.now() }) + '\\n');
event('start');
await new Promise((resolve) => setTimeout(resolve, 40));
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
mkdirSync(path.join(job, 'trial', 'verifier'), { recursive: true });
writeFileSync(path.join(job, 'trial', 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
event('end');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const args = [...campaignArgs, '--seed', 'episode-order-seed'];
  args[args.indexOf('--arm') + 1] = 'baseline';
  args[args.indexOf('--concurrency') + 1] = '2';
  const result = await run(args, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HARBOR_CAPTURE_FILE: capture },
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  assert.equal(plan.trials.length, declared.episodes.length);
  assert.deepEqual(
    plan.trials.map((trial) => trial.episodeIndex),
    declared.episodes.map((episode) => episode.index),
  );
  assert.deepEqual(
    [...plan.trials].sort((left, right) => left.executionIndex - right.executionIndex)
      .map((trial) => trial.episodeIndex),
    declared.episodes.map((episode) => episode.index),
  );
  assert.ok(plan.trials.every((trial) => trial.status === 'verified'));

  const events = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  for (let index = 1; index < plan.trials.length; index += 1) {
    const previous = plan.trials[index - 1];
    const current = plan.trials[index];
    const previousEnd = events.findIndex((event) => event.name === 'end' && event.jobName === previous.trialId);
    const currentStart = events.findIndex((event) => event.name === 'start' && event.jobName === current.trialId);
    assert.ok(
      previousEnd >= 0 && currentStart > previousEnd,
      `episode ${current.episodeIndex} must not start before episode ${previous.episodeIndex} ends`,
    );
  }
});

test('campaign operational failure stops that arm and continues the other', async (t) => {
  const declared = JSON.parse(await readFile(path.join(here, 'corpora/forgekit-campaign-v1.json'), 'utf8'));
  const failedEpisode = declared.episodes.find((episode) => episode.index === 3);
  const remainingEpisodes = declared.episodes.filter((episode) => episode.index > failedEpisode.index);
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-campaign-stop-'));
  const capture = path.join(bin, 'events.jsonl');
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const jobName = args[args.indexOf('--job-name') + 1];
const event = (name) => appendFileSync(process.env.HARBOR_CAPTURE_FILE, JSON.stringify({ name, jobName, at: Date.now() }) + '\\n');
event('start');
if (jobName.includes('${failedEpisode.id}-baseline-')) { event('end'); process.exit(9); }
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
mkdirSync(path.join(job, 'trial', 'verifier'), { recursive: true });
writeFileSync(path.join(job, 'trial', 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
event('end');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const result = await run([...campaignArgs, '--seed', 'episode-stop-seed'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HARBOR_CAPTURE_FILE: capture },
  });
  assert.notEqual(result.code, 0);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));
  assert.equal(plan.status, 'completed-with-failures');

  const baseline = plan.trials.filter((trial) => trial.arm === 'baseline');
  const forge = plan.trials.filter((trial) => trial.arm === 'forge');
  assert.equal(baseline.length, declared.episodes.length);
  assert.equal(forge.length, declared.episodes.length);

  const failedTrial = baseline.find((trial) => trial.episodeIndex === failedEpisode.index);
  assert.equal(failedTrial.status, 'failed');
  for (const episode of remainingEpisodes) {
    const trial = baseline.find((candidate) => candidate.episodeIndex === episode.index);
    assert.equal(trial.status, 'not-attempted');
    const manifest = JSON.parse(await readFile(manifestFile(plan, trial), 'utf8'));
    assert.equal(manifest.status, 'not-attempted');
  }
  assert.ok(forge.every((trial) => trial.status === 'verified'));
  assert.deepEqual(
    forge.map((trial) => trial.episodeIndex),
    declared.episodes.map((episode) => episode.index),
  );

  const persisted = JSON.parse(await readFile(path.join(plan.runDirectory, 'plan.json'), 'utf8'));
  assert.deepEqual(
    persisted.trials.filter((trial) => trial.arm === 'baseline' && trial.episodeIndex > failedEpisode.index)
      .map((trial) => trial.status),
    remainingEpisodes.map(() => 'not-attempted'),
  );

  const events = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  const startedJobs = new Set(events.filter((event) => event.name === 'start').map((event) => event.jobName));
  for (const episode of remainingEpisodes) {
    const trial = baseline.find((candidate) => candidate.episodeIndex === episode.index);
    assert.equal(startedJobs.has(trial.trialId), false, `${trial.trialId} must not invoke Harbor`);
  }
});

test('campaign seeded schedules hash campaign identity and alternate across repetitions', async (t) => {
  const declared = JSON.parse(await readFile(path.join(here, 'corpora/forgekit-campaign-v1.json'), 'utf8'));
  const seed = 'campaign-schedule-seed';
  const args = [...campaignArgs, '--seed', seed, '--dry-run'];
  args[args.indexOf('--repetitions') + 1] = '2';
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  const startHash = createHash('sha256')
    .update(`${seed}\0${declared.corpus_id}\0${plan.taskRevision}`)
    .digest('hex');
  const startingArm = Number.parseInt(startHash.slice(0, 2), 16) % 2 === 0 ? 'baseline' : 'forge';
  const otherArm = startingArm === 'baseline' ? 'forge' : 'baseline';

  assert.equal(plan.schedule.strategy, 'seeded-counterbalanced-pairs');
  assert.equal(plan.schedule.seed, seed);
  assert.equal(plan.schedule.startHash, startHash);
  assert.equal(plan.schedule.startingArm, startingArm);
  assert.deepEqual(plan.schedule.armOrders, [
    [startingArm, otherArm],
    [otherArm, startingArm],
  ]);
  assert.deepEqual(plan.schedule.firstArmCounts, { baseline: 1, forge: 1 });
  assert.deepEqual(
    plan.trials.map((trial) => ({ arm: trial.arm, episodeIndex: trial.episodeIndex, repetition: trial.repetition })),
    plan.schedule.armOrders.flatMap((armOrder, repetitionIndex) => (
      armOrder.flatMap((arm) => declared.episodes.map((episode) => ({
        arm,
        episodeIndex: episode.index,
        repetition: repetitionIndex + 1,
      })))
    )),
  );
});

test('campaign dry-run stages episode 2 app from episode 1 of the same arm', async (t) => {
  const campaignRoot = path.join(here, 'tasks/forgekit-campaign-v1');
  const episode1App = path.join(campaignRoot, 'episode-01/environment/app');
  const episode2App = path.join(campaignRoot, 'episode-02/environment/app');
  const episode2Canonical = new Set(await listRelativeFiles(episode2App));
  const inherited = (await listRelativeFiles(episode1App)).filter((file) => !episode2Canonical.has(file));
  assert.ok(inherited.length > 0);

  const result = await run([...campaignArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  for (const arm of ['baseline', 'forge']) {
    const trial = plan.trials.find((candidate) => candidate.arm === arm && candidate.episodeId === 'episode-02');
    const stagedApp = path.join(plan.runDirectory, trialStagedPath(trial), 'environment', 'app');
    for (const relative of inherited) {
      const expected = await readFile(path.join(episode1App, relative), 'utf8');
      const actual = await readFile(path.join(stagedApp, relative), 'utf8');
      assert.equal(actual, expected);
    }
  }
});

test('campaign staging never places verifier sources in any agent environment', async (t) => {
  const campaignRoot = path.join(here, 'tasks/forgekit-campaign-v1');
  const declared = JSON.parse(await readFile(path.join(here, 'corpora/forgekit-campaign-v1.json'), 'utf8'));
  const verifierContents = [];
  for (const episode of declared.episodes) {
    const testsDir = path.join(campaignRoot, episode.id, 'tests');
    for (const relative of await listRelativeFiles(testsDir)) {
      verifierContents.push(await readFile(path.join(testsDir, relative)));
    }
  }
  assert.ok(verifierContents.length > 0);
  assert.equal(declared.episodes.length, 6);

  const result = await run([...campaignArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  for (const trial of plan.trials) {
    const environment = path.join(plan.runDirectory, trialStagedPath(trial), 'environment');
    for (const relative of await listRelativeFiles(environment)) {
      const staged = await readFile(path.join(environment, relative));
      for (const verifier of verifierContents) {
        assert.notEqual(
          Buffer.compare(staged, verifier),
          0,
          `${trial.arm} ${trial.episodeId} environment/${relative} matches a verifier file`,
        );
      }
    }
  }
});

test('campaign arms do not share carried repository state', async (t) => {
  const baselineOnly = 'baseline-arm-only.txt';
  const forgeOnly = 'forge-arm-only.txt';
  const baselineBytes = 'written-by-baseline-episode-01\n';
  const forgeBytes = 'written-by-forge-episode-01\n';
  const bin = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-arm-isolation-'));
  const fakeHarbor = path.join(bin, 'harbor');
  await writeFile(fakeHarbor, `#!/usr/bin/env node
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('harbor 0.20.0'); process.exit(0); }
const jobName = args[args.indexOf('--job-name') + 1];
const staged = args[args.indexOf('--path') + 1];
const job = path.join(args[args.indexOf('--jobs-dir') + 1], 'job');
const appOut = path.join(job, 'trial', 'artifacts', 'app');
cpSync(path.join(staged, 'environment', 'app'), appOut, { recursive: true });
if (jobName.includes('episode-01-baseline-')) {
  writeFileSync(path.join(appOut, ${JSON.stringify(baselineOnly)}), ${JSON.stringify(baselineBytes)});
}
if (jobName.includes('episode-01-forge-')) {
  writeFileSync(path.join(appOut, ${JSON.stringify(forgeOnly)}), ${JSON.stringify(forgeBytes)});
}
mkdirSync(path.join(job, 'trial', 'verifier'), { recursive: true });
writeFileSync(path.join(job, 'trial', 'verifier', 'reward.json'), '{"functional":1,"regression":1,"tests_unchanged":1,"shippable":1}');
`);
  await chmod(fakeHarbor, 0o755);
  t.after(() => rm(bin, { recursive: true, force: true }));

  const result = await run([...campaignArgs, '--seed', 'arm-isolation-seed'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  const baselineEpisode2 = plan.trials.find((trial) => trial.arm === 'baseline' && trial.episodeId === 'episode-02');
  const forgeEpisode2 = plan.trials.find((trial) => trial.arm === 'forge' && trial.episodeId === 'episode-02');
  const baselineApp = path.join(plan.runDirectory, trialStagedPath(baselineEpisode2), 'environment', 'app');
  const forgeApp = path.join(plan.runDirectory, trialStagedPath(forgeEpisode2), 'environment', 'app');
  assert.equal(await readFile(path.join(baselineApp, baselineOnly), 'utf8'), baselineBytes);
  assert.equal(await readFile(path.join(forgeApp, forgeOnly), 'utf8'), forgeBytes);
  await assert.rejects(() => readFile(path.join(forgeApp, baselineOnly)));
  await assert.rejects(() => readFile(path.join(baselineApp, forgeOnly)));
});

test('campaign dry-run stages distinct directories per repetition', async (t) => {
  const repetitions = 2;
  const args = [...campaignArgs, '--dry-run'];
  args[args.indexOf('--repetitions') + 1] = String(repetitions);
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  t.after(() => cleanupPlan(plan));

  const stagedPaths = plan.trials.map(trialStagedPath);
  assert.equal(new Set(stagedPaths).size, stagedPaths.length);

  const episode2 = plan.trials.filter((trial) => trial.arm === 'baseline' && trial.episodeId === 'episode-02');
  assert.equal(episode2.length, repetitions);
  const directories = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const trial = episode2.find((candidate) => candidate.repetition === repetition);
    const relative = trialStagedPath(trial);
    assert.equal(relative, `arms/baseline/r${String(repetition).padStart(3, '0')}/episode-02`);
    const directory = path.join(plan.runDirectory, relative);
    assert.equal((await stat(directory)).isDirectory(), true);
    directories.push(path.resolve(directory));
  }
  assert.notEqual(directories[0], directories[1]);
});
