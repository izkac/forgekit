import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CARRYOVER_MARKER,
  assertCarryoverPrecondition,
} from './tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run.mjs');
const aggregate = path.join(here, 'aggregate-results.mjs');
const projectRoot = path.resolve(here, '..', '..');

async function withTempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-carryover-precondition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('missing inherited marker writes no reward.json and rejects', async (t) => {
  const root = await withTempDir(t);
  const appDirectory = path.join(root, 'app');
  const rewardPath = path.join(root, 'reward.json');
  await mkdir(appDirectory);
  await assert.rejects(
    () => assertCarryoverPrecondition({ episodeIndex: 2, appDirectory, rewardPath }),
  );
  await assert.rejects(() => readFile(rewardPath));
});

test('present inherited marker does not throw', async (t) => {
  const root = await withTempDir(t);
  const appDirectory = path.join(root, 'app');
  const rewardPath = path.join(root, 'reward.json');
  await mkdir(appDirectory);
  await writeFile(path.join(appDirectory, CARRYOVER_MARKER), 'inherited\n');
  await assertCarryoverPrecondition({ episodeIndex: 2, appDirectory, rewardPath });
  await assert.rejects(() => readFile(rewardPath));
});

test('episode 1 does not require a carryover marker', async (t) => {
  const root = await withTempDir(t);
  const appDirectory = path.join(root, 'app');
  const rewardPath = path.join(root, 'reward.json');
  await mkdir(appDirectory);
  await assertCarryoverPrecondition({ episodeIndex: 1, appDirectory, rewardPath });
  await assert.rejects(() => readFile(rewardPath));
});

test('campaign carryover writes the inherited marker into later episode apps', async (t) => {
  const runsRoot = await withTempDir(t);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner,
      '--corpus', 'forgekit-campaign-v1',
      '--arm', 'both',
      '--repetitions', '1',
      '--concurrency', '1',
      '--agent', 'claude-code',
      '--model', 'anthropic/claude-sonnet-4',
      '--forgekit-version', '0.3.37',
      '--dry-run',
    ], {
      cwd: projectRoot,
      env: { ...process.env, FORGEKIT_EVAL_RUNS_ROOT: runsRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const runDirectory = path.join(runsRoot, plan.runId);
  const episode1 = plan.trials.find((trial) => trial.arm === 'baseline' && trial.episodeId === 'episode-01');
  const episode2 = plan.trials.find((trial) => trial.arm === 'baseline' && trial.episodeId === 'episode-02');
  const forgeEpisode2 = plan.trials.find((trial) => trial.arm === 'forge' && trial.episodeId === 'episode-02');
  const episode1Marker = path.join(runDirectory, episode1.harborArgv[episode1.harborArgv.indexOf('--path') + 1], 'environment', 'app', CARRYOVER_MARKER);
  const episode2Marker = path.join(runDirectory, episode2.harborArgv[episode2.harborArgv.indexOf('--path') + 1], 'environment', 'app', CARRYOVER_MARKER);
  const forgeEpisode2Marker = path.join(runDirectory, forgeEpisode2.harborArgv[forgeEpisode2.harborArgv.indexOf('--path') + 1], 'environment', 'app', CARRYOVER_MARKER);
  await assert.rejects(() => readFile(episode1Marker));
  assert.equal((await readFile(episode2Marker, 'utf8')).length > 0, true);
  assert.equal((await readFile(forgeEpisode2Marker, 'utf8')).length > 0, true);
});

function normalized({ arm, task, trial, shippable }) {
  return {
    schema_version: 1,
    arm,
    task,
    trial,
    outcome: {
      functional: shippable,
      regression: shippable,
      tests_unchanged: shippable,
      shippable,
    },
    instrumentation: {
      available: arm === 'forge',
      reason: arm === 'forge' ? null : 'not applicable',
      forge: null,
      harbor: {
        available: false,
        reason: 'not reported',
        wall_clock_seconds: null,
        input_tokens: null,
        cache_tokens: null,
        output_tokens: null,
        cost_usd: null,
        retries: null,
      },
    },
  };
}

test('a pair missing a normalized result is incomplete rather than a zero outcome', async (t) => {
  const root = await withTempDir(t);
  const runId = 'carryover-incomplete';
  const directory = path.join(root, runId);
  const task = 'forgekit-campaign-v1';
  const category = 'campaign';
  const corpus = { id: 'forgekit-campaign-v1', revision: 'corpus-v1' };
  const treatment = { kind: 'published-version', version: '1.2.3' };
  const images = { agent: 'node@sha256:aaa', verifier: 'node@sha256:bbb' };
  await mkdir(path.join(directory, 'trials'), { recursive: true });

  const cells = [
    { arm: 'baseline', repetition: 1, status: 'verified', shippable: 1 },
    { arm: 'forge', repetition: 1, status: 'failed', error: 'carryover precondition failed: missing inherited marker' },
  ];
  const trials = [];
  for (const cell of cells) {
    const trialId = `${task}-${cell.arm}-${cell.repetition}`;
    const trialDirectory = path.join(directory, 'trials', trialId);
    await mkdir(trialDirectory);
    const resultPath = path.join('trials', trialId, 'normalized-result.json');
    const manifestPath = path.join('trials', trialId, 'manifest.json');
    const manifest = {
      schemaVersion: 1,
      runId,
      trialId,
      task,
      category,
      taskRevision: 'revision-campaign',
      corpus,
      harnessRevision: 'harness-abc',
      arm: cell.arm,
      repetition: cell.repetition,
      agent: 'codex',
      model: 'example/model',
      forgekitTreatment: treatment,
      images,
      settings: { repetitions: 1, concurrency: 1 },
      seed: 'experiment-seed',
      scheduleIndex: cell.arm === 'baseline' ? 1 : 2,
      executionIndex: cell.arm === 'baseline' ? 1 : 2,
      armOrder: ['baseline', 'forge'],
      armOrdinal: cell.arm === 'baseline' ? 1 : 2,
      harbor: { executable: 'harbor', version: '0.20.0', versionSource: 'harbor --version', argv: ['run'] },
      status: cell.status,
      ...(cell.status === 'verified' ? { normalizedResult: resultPath } : { error: cell.error }),
    };
    await writeFile(path.join(directory, manifestPath), `${JSON.stringify(manifest)}\n`);
    if (cell.status === 'verified') {
      await writeFile(path.join(directory, resultPath), `${JSON.stringify(normalized({
        arm: cell.arm,
        task,
        trial: cell.repetition,
        shippable: cell.shippable,
      }))}\n`);
    }
    trials.push({
      trialId,
      arm: cell.arm,
      repetition: cell.repetition,
      scheduleIndex: manifest.scheduleIndex,
      executionIndex: manifest.executionIndex,
      armOrder: manifest.armOrder,
      armOrdinal: manifest.armOrdinal,
      manifest: manifestPath,
      status: cell.status,
    });
  }

  const plan = {
    schemaVersion: 1,
    runId,
    runDirectory: directory,
    dryRun: false,
    status: 'completed-with-failures',
    task,
    category,
    taskRevision: 'revision-campaign',
    corpus,
    harnessRevision: 'harness-abc',
    images,
    settings: {
      arm: 'both',
      repetitions: 1,
      concurrency: 1,
      seed: 'experiment-seed',
      agent: 'codex',
      model: 'example/model',
      forgekitTreatment: treatment,
    },
    trials,
  };
  await writeFile(path.join(directory, 'plan.json'), `${JSON.stringify(plan)}\n`);

  const invoked = spawnSync(process.execPath, [aggregate, '--run-directory', directory], { encoding: 'utf8' });
  assert.equal(invoked.status, 0, invoked.stderr);
  const report = JSON.parse(invoked.stdout);
  assert.equal(report.pairs.complete, 0);
  assert.equal(report.pairs.incomplete, 1);
  assert.deepEqual(report.pairs.incomplete_pairs, [{
    task,
    category,
    repetition: 1,
    present_arms: ['baseline'],
    missing_arms: ['forge'],
    arm_statuses: { baseline: 'verified', forge: 'failed' },
  }]);
  assert.equal(report.pairs.outcomes.shippable.pairs, 0);
  assert.equal(report.primary.mean_delta, null);
});
