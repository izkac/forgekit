import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const aggregate = path.resolve('evals/harbor/aggregate-results.mjs');

function normalized({ arm, task, trial, shippable, cost = null, seconds = null }) {
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
        available: cost !== null || seconds !== null,
        reason: cost !== null || seconds !== null ? null : 'not reported',
        wall_clock_seconds: seconds,
        input_tokens: null,
        cache_tokens: null,
        output_tokens: null,
        cost_usd: cost,
        retries: null,
      },
    },
  };
}

function createRun(root, {
  runId,
  task,
  category,
  cells,
  agent = 'codex',
  model = 'example/model',
  harnessRevision = 'harness-abc',
  treatment = { kind: 'published-version', version: '1.2.3' },
  selectedArm = 'both',
  taskRevision = `revision-${task}`,
  corpus = { id: 'test-corpus', revision: 'corpus-v1' },
} = {}) {
  const directory = path.join(root, runId);
  mkdirSync(path.join(directory, 'trials'), { recursive: true });
  const trials = [];
  for (const cell of cells) {
    const trialId = `${task}-${cell.arm}-${cell.repetition}`;
    const trialDirectory = path.join(directory, 'trials', trialId);
    mkdirSync(trialDirectory);
    const resultPath = path.join('trials', trialId, 'normalized-result.json');
    const status = cell.status ?? 'verified';
    const manifestPath = path.join('trials', trialId, 'manifest.json');
    const manifest = {
      schemaVersion: 1,
      runId,
      trialId,
      task,
      category,
      taskRevision,
      corpus,
      harnessRevision,
      arm: cell.arm,
      repetition: cell.repetition,
      agent,
      model,
      forgekitTreatment: treatment,
      images: { agent: 'node@sha256:aaa', verifier: 'node@sha256:bbb' },
      settings: { repetitions: 2, concurrency: 1 },
      seed: 'experiment-seed',
      scheduleIndex: (cell.repetition - 1) * 2 + (cell.arm === 'baseline' ? 1 : 2),
      executionIndex: (cell.repetition - 1) * 2 + (cell.arm === 'baseline' ? 1 : 2),
      armOrder: ['baseline', 'forge'],
      armOrdinal: cell.arm === 'baseline' ? 1 : 2,
      harbor: { executable: 'harbor', version: '0.20.0', versionSource: 'harbor --version', argv: ['run'] },
      status,
      ...(status === 'verified' ? { normalizedResult: resultPath } : { error: cell.error ?? 'Harbor failed' }),
    };
    writeFileSync(path.join(directory, manifestPath), `${JSON.stringify(manifest)}\n`);
    if (status === 'verified') {
      writeFileSync(path.join(directory, resultPath), `${JSON.stringify(normalized({
        arm: cell.arm,
        task,
        trial: cell.repetition,
        shippable: cell.shippable,
        cost: cell.cost,
        seconds: cell.seconds,
      }))}\n`);
    }
    trials.push({
      trialId,
      arm: cell.arm,
      repetition: cell.repetition,
      scheduleIndex: (cell.repetition - 1) * 2 + (cell.arm === 'baseline' ? 1 : 2),
      executionIndex: (cell.repetition - 1) * 2 + (cell.arm === 'baseline' ? 1 : 2),
      armOrder: ['baseline', 'forge'],
      armOrdinal: cell.arm === 'baseline' ? 1 : 2,
      manifest: manifestPath,
      status,
    });
  }
  const plan = {
    schemaVersion: 1,
    runId,
    runDirectory: directory,
    dryRun: false,
    status: cells.some((cell) => cell.status === 'failed') ? 'completed-with-failures' : 'completed',
    task,
    category,
    taskRevision,
    corpus,
    harnessRevision,
    images: { agent: 'node@sha256:aaa', verifier: 'node@sha256:bbb' },
    settings: {
      arm: selectedArm,
      repetitions: 2,
      concurrency: 1,
      seed: 'experiment-seed',
      agent,
      model,
      forgekitTreatment: treatment,
    },
    trials,
  };
  writeFileSync(path.join(directory, 'plan.json'), `${JSON.stringify(plan)}\n`);
  return directory;
}

function invoke(directories) {
  const argv = directories.flatMap((directory) => ['--run-directory', directory]);
  return spawnSync(process.execPath, [aggregate, ...argv], { encoding: 'utf8' });
}

test('aggregates coherent runs by arm, category, and task using complete pairs only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-'));
  const first = createRun(root, {
    runId: 'run-feature',
    task: 'feature-task',
    category: 'feature',
    cells: [
      { arm: 'baseline', repetition: 1, shippable: 0, cost: 1, seconds: 10 },
      { arm: 'forge', repetition: 1, shippable: 1, cost: 1.5, seconds: 8 },
      { arm: 'baseline', repetition: 2, shippable: 1, cost: 1.2, seconds: 11 },
      { arm: 'forge', repetition: 2, status: 'failed', error: 'Harbor exited with code 1' },
    ],
  });
  const second = createRun(root, {
    runId: 'run-security',
    task: 'security-task',
    category: 'security',
    cells: [
      { arm: 'baseline', repetition: 1, shippable: 1, cost: 2, seconds: 20 },
      { arm: 'forge', repetition: 1, shippable: 0, cost: null, seconds: 18 },
    ],
  });

  const result = invoke([first, second]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.cohort, {
    agent: 'codex',
    model: 'example/model',
    forgekit_treatment: { kind: 'published-version', version: '1.2.3' },
    harness_revision: 'harness-abc',
    corpus: { id: 'test-corpus', revision: 'corpus-v1' },
    settings: { repetitions: 2, concurrency: 1, seed: 'experiment-seed' },
  });
  assert.deepEqual(report.arms.baseline.outcomes.shippable, { observations: 3, successes: 2, rate: 2 / 3 });
  assert.deepEqual(report.arms.forge.outcomes.shippable, { observations: 2, successes: 1, rate: 0.5 });
  assert.equal(report.categories.feature.arms.forge.outcomes.shippable.successes, 1);
  assert.equal(report.tasks['security-task'].category, 'security');
  assert.equal(report.tasks['security-task'].arms.baseline.outcomes.shippable.successes, 1);

  assert.equal(report.pairs.complete, 2);
  assert.equal(report.pairs.incomplete, 1);
  assert.deepEqual(report.pairs.incomplete_pairs, [{
    task: 'feature-task',
    category: 'feature',
    repetition: 2,
    present_arms: ['baseline'],
    missing_arms: ['forge'],
    arm_statuses: { baseline: 'verified', forge: 'failed' },
  }]);
  assert.deepEqual(report.operations, { planned: 6, verified: 5, failed: 1 });
  assert.deepEqual(report.arms.forge.operations, { planned: 3, verified: 2, failed: 1 });
  assert.deepEqual(report.pairs.outcomes.shippable, {
    pairs: 2,
    baseline_successes: 1,
    forge_successes: 1,
    mean_delta: 0,
    wins: 1,
    losses: 1,
    ties: 0,
  });
  assert.deepEqual(report.pairs.instrumentation.cost_usd, {
    pairs: 1,
    missing_pairs: 1,
    missing_baseline: 0,
    missing_forge: 1,
    baseline_mean: 1,
    forge_mean: 1.5,
    mean_delta: 0.5,
  });
  assert.ok(Array.isArray(report.limitations));
  assert.match(report.limitations.join(' '), /complete pairs/i);
  assert.match(report.limitations.join(' '), /causal|representative|held.out/i);
  assert.equal(Object.hasOwn(report, 'verdict'), false);
  assert.equal(Object.hasOwn(report, 'effectiveness'), false);
  assert.deepEqual(report.run_ids, ['run-feature', 'run-security']);
  assert.equal(JSON.stringify(report).includes(root), false, 'aggregate output must not leak input host paths');
});

test('primary summary weights tasks equally instead of overweighting repeated task pairs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-macro-'));
  const feature = createRun(root, {
    runId: 'macro-feature', task: 'feature-task', category: 'feature',
    cells: [
      { arm: 'baseline', repetition: 1, shippable: 0 }, { arm: 'forge', repetition: 1, shippable: 1 },
      { arm: 'baseline', repetition: 2, shippable: 0 }, { arm: 'forge', repetition: 2, shippable: 1 },
    ],
  });
  const security = createRun(root, {
    runId: 'macro-security', task: 'security-task', category: 'security',
    cells: [
      { arm: 'baseline', repetition: 1, shippable: 1 }, { arm: 'forge', repetition: 1, shippable: 0 },
    ],
  });
  const result = invoke([feature, security]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pairs.outcomes.shippable.mean_delta, 1 / 3, 'pooled micro result remains descriptive');
  assert.deepEqual(report.primary, {
    endpoint: 'shippable',
    estimand: 'equal-task-weighted mean of within-task paired deltas',
    complete_tasks: 2,
    mean_delta: 0,
  });
});

test('pairs baseline and forge observations from separate single-arm run directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-arms-'));
  const baseline = createRun(root, {
    runId: 'run-baseline', task: 'split-task', category: 'tests', selectedArm: 'baseline',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 0 }],
  });
  const forge = createRun(root, {
    runId: 'run-forge', task: 'split-task', category: 'tests', selectedArm: 'forge',
    cells: [{ arm: 'forge', repetition: 1, shippable: 1 }],
  });
  const result = invoke([baseline, forge]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pairs.complete, 1);
  assert.equal(report.pairs.outcomes.shippable.wins, 1);
});

test('refuses to pair split arms from different task or corpus revisions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-provenance-'));
  const baseline = createRun(root, {
    runId: 'revision-a', task: 'same-task', category: 'bug', selectedArm: 'baseline',
    taskRevision: 'revision-a',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 0 }],
  });
  const forge = createRun(root, {
    runId: 'revision-b', task: 'same-task', category: 'bug', selectedArm: 'forge',
    taskRevision: 'revision-b',
    cells: [{ arm: 'forge', repetition: 1, shippable: 1 }],
  });
  const result = invoke([baseline, forge]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task revision|provenance|cohort/i);
  assert.equal(result.stdout, '');
});

test('refuses provenance drift across repetitions of the same task', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-repetition-provenance-'));
  const directories = [
    createRun(root, { runId: 'rep1-base', task: 'same-task', category: 'bug', selectedArm: 'baseline', taskRevision: 'rev-a', cells: [{ arm: 'baseline', repetition: 1, shippable: 0 }] }),
    createRun(root, { runId: 'rep1-forge', task: 'same-task', category: 'bug', selectedArm: 'forge', taskRevision: 'rev-a', cells: [{ arm: 'forge', repetition: 1, shippable: 1 }] }),
    createRun(root, { runId: 'rep2-base', task: 'same-task', category: 'bug', selectedArm: 'baseline', taskRevision: 'rev-b', cells: [{ arm: 'baseline', repetition: 2, shippable: 0 }] }),
    createRun(root, { runId: 'rep2-forge', task: 'same-task', category: 'bug', selectedArm: 'forge', taskRevision: 'rev-b', cells: [{ arm: 'forge', repetition: 2, shippable: 1 }] }),
  ];
  const result = invoke(directories);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task revision|provenance/i);
  assert.equal(result.stdout, '');
});

test('refuses mixed cohorts without emitting an aggregate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-mixed-'));
  const one = createRun(root, {
    runId: 'run-one', task: 'one', category: 'bug',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1 }],
  });
  const two = createRun(root, {
    runId: 'run-two', task: 'two', category: 'tests', model: 'other/model',
    cells: [{ arm: 'forge', repetition: 1, shippable: 1 }],
  });
  const result = invoke([one, two]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /mixed cohort.*model/i);
});

test('refuses duplicate cells and malformed normalized outcomes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-invalid-'));
  const directory = createRun(root, {
    runId: 'run-invalid', task: 'same', category: 'refactor',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1 }],
  });
  const planPath = path.join(directory, 'plan.json');
  const plan = JSON.parse(requireText(planPath));
  plan.trials.push({ ...plan.trials[0] });
  writeFileSync(planPath, JSON.stringify(plan));
  let result = invoke([directory]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /duplicate.*same.*1.*baseline/i);

  plan.trials.pop();
  writeFileSync(planPath, JSON.stringify(plan));
  const normalizedPath = path.join(directory, 'trials', 'same-baseline-1', 'normalized-result.json');
  const value = JSON.parse(requireText(normalizedPath));
  value.outcome.shippable = 2;
  writeFileSync(normalizedPath, JSON.stringify(value));
  result = invoke([directory]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /shippable.*binary/i);
});

test('refuses traversal and symlink run directories before reading data', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-safe-'));
  const directory = createRun(root, {
    runId: 'run-safe', task: 'safe', category: 'integration',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1 }],
  });
  const result = invoke([`${directory}/../${path.basename(directory)}`]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /traversal|\.\./i);
});

function requireText(file) {
  return readFileSync(file, 'utf8');
}
