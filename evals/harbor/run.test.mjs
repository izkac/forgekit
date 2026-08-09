import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  '--agent', 'claude-code',
  '--model', 'anthropic/claude-sonnet-4',
  '--forgekit-version', '0.3.37',
];

async function cleanupPlan(plan) {
  if (plan?.runDirectory) await rm(plan.runDirectory, { recursive: true, force: true });
}

test('dry run stages canonical baseline and Forge arms and writes trial manifests', async (t) => {
  const result = await run([...validArgs, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  t.after(() => cleanupPlan(plan));

  assert.equal(plan.dryRun, true);
  assert.match(plan.harnessRevision, /^[a-f0-9]{64}$/);
  assert.equal(plan.trials.length, 4);
  assert.deepEqual(plan.trials.map(({ arm, repetition }) => [arm, repetition]), [
    ['baseline', 1], ['forge', 1], ['baseline', 2], ['forge', 2],
  ]);

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
    const manifest = JSON.parse(await readFile(trial.manifest, 'utf8'));
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
  }
});

test('rejects invalid input before creating a run', async () => {
  const cases = [
    [['--arm', 'control'], 'arm must be one of'],
    [['--repetitions', '0'], 'repetitions must be a positive integer'],
    [['--repetitions', '1.5'], 'repetitions must be a positive integer'],
    [['--concurrency', '-1'], 'concurrency must be a positive integer'],
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
  const plan = JSON.parse(result.stdout);
  t.after(() => cleanupPlan(plan));
  const captured = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(captured, [plan.trials[0].harborArgv]);
  assert.equal(plan.trials[0].status, 'verified');
  assert.equal(captured[0].includes('--n-concurrent'), true);
  assert.equal(captured[0][captured[0].indexOf('--n-concurrent') + 1], '1');
  assert.equal(captured[0].includes('--artifact'), false);
  const manifest = JSON.parse(await readFile(plan.trials[0].manifest, 'utf8'));
  assert.equal(manifest.harbor.version, 'harbor 0.20.0');
  assert.equal(manifest.status, 'verified');
  assert.deepEqual(manifest.resolvedAgent, { name: 'fake-agent', version: '1.2.3' });
  assert.deepEqual(JSON.parse(await readFile(manifest.normalizedResult, 'utf8')).outcome, {
    functional: 1, regression: 1, tests_unchanged: 1, shippable: 1,
  });
  const normalized = JSON.parse(await readFile(manifest.normalizedResult, 'utf8'));
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
  const plan = JSON.parse(result.stdout);
  t.after(() => cleanupPlan(plan));
  const invoked = JSON.parse((await readFile(capture, 'utf8')).trim());
  assert.equal(invoked[invoked.indexOf('--artifact') + 1], '/app/.forge');
  const manifest = JSON.parse(await readFile(plan.trials[0].manifest, 'utf8'));
  const normalized = JSON.parse(await readFile(manifest.normalizedResult, 'utf8'));
  assert.equal(normalized.instrumentation.available, true);
  assert.match(normalized.instrumentation.forge.artifactPath, /\.forge$/);
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
