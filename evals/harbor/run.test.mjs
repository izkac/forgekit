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

async function cleanupPlan(plan) {
  if (plan?.runDirectory) await rm(plan.runDirectory, { recursive: true, force: true });
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
  process.stdout.write('harbor 0.20.0\\n');
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
  agent_info: { name: 'fake-agent', version: '1.2.3' },
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
  assert.equal(manifest.harbor.version, 'harbor 0.20.0');
  assert.equal(manifest.status, 'verified');
  assert.deepEqual(manifest.resolvedAgent, { name: 'fake-agent', version: '1.2.3' });
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
