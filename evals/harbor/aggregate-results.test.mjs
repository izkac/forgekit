import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const aggregate = path.resolve('evals/harbor/aggregate-results.mjs');

function normalized({
  arm, task, trial, shippable, cost = null, seconds = null,
  schemaVersion = 1, counts, falseCompletion, rewardShape,
}) {
  return {
    schema_version: schemaVersion,
    arm,
    task,
    trial,
    ...(rewardShape === undefined ? {} : { reward_shape: rewardShape }),
    outcome: {
      functional: shippable,
      regression: shippable,
      tests_unchanged: shippable,
      shippable,
    },
    ...(counts === undefined ? {} : { counts }),
    ...(falseCompletion === undefined ? {} : { false_completion: falseCompletion }),
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
  campaignRevision,
  campaign,
  taskVersion,
  manifestTaskVersion = taskVersion,
  corpus = { id: 'test-corpus', revision: 'corpus-v1' },
} = {}) {
  const directory = path.join(root, runId);
  mkdirSync(path.join(directory, 'trials'), { recursive: true });
  const planTaskRevision = campaignRevision ?? taskRevision;
  const trials = [];
  for (const [cellIndex, cell] of cells.entries()) {
    const hasEpisode = cell.episodeIndex !== undefined;
    const trialId = hasEpisode
      ? `${cell.episodeId}-${cell.arm}-${String(cell.repetition).padStart(3, '0')}`
      : `${task}-${cell.arm}-${cell.repetition}`;
    const trialDirectory = path.join(directory, 'trials', trialId);
    mkdirSync(trialDirectory);
    const resultPath = path.join('trials', trialId, 'normalized-result.json');
    const status = cell.status ?? 'verified';
    const manifestPath = path.join('trials', trialId, 'manifest.json');
    const scheduleIndex = hasEpisode
      ? cellIndex + 1
      : (cell.repetition - 1) * 2 + (cell.arm === 'baseline' ? 1 : 2);
    const manifest = {
      schemaVersion: 1,
      runId,
      trialId,
      task,
      ...(manifestTaskVersion === undefined ? {} : { taskVersion: manifestTaskVersion }),
      category,
      taskRevision: cell.episodeRevision ?? planTaskRevision,
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
      scheduleIndex,
      executionIndex: scheduleIndex,
      armOrder: ['baseline', 'forge'],
      armOrdinal: cell.arm === 'baseline' ? 1 : 2,
      harbor: { executable: 'harbor', version: '0.20.0', versionSource: 'harbor --version', argv: ['run'] },
      status,
      ...(hasEpisode ? { episodeId: cell.episodeId, episodeIndex: cell.episodeIndex } : {}),
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
        schemaVersion: cell.schemaVersion,
        counts: cell.counts,
        falseCompletion: cell.falseCompletion,
        rewardShape: cell.rewardShape,
      }))}\n`);
    }
    trials.push({
      trialId,
      arm: cell.arm,
      repetition: cell.repetition,
      scheduleIndex,
      executionIndex: scheduleIndex,
      armOrder: ['baseline', 'forge'],
      armOrdinal: cell.arm === 'baseline' ? 1 : 2,
      ...(hasEpisode ? { episodeId: cell.episodeId, episodeIndex: cell.episodeIndex } : {}),
      manifest: manifestPath,
      status,
    });
  }
  const plan = {
    schemaVersion: 1,
    runId,
    runDirectory: directory,
    dryRun: false,
    status: cells.some((cell) => cell.status === 'failed' || cell.status === 'not-attempted')
      ? 'completed-with-failures'
      : 'completed',
    task,
    ...(taskVersion === undefined ? {} : { taskVersion }),
    category,
    taskRevision: planTaskRevision,
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
    ...(campaign === undefined ? {} : { campaign }),
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

test('validates and binds taskVersion for new runs while accepting legacy runs without it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-task-version-'));
  const legacy = createRun(root, {
    runId: 'legacy-versionless', task: 'legacy-task', category: 'bug',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1 }],
  });
  let result = invoke([legacy]);
  assert.equal(result.status, 0, result.stderr);

  const versioned = createRun(root, {
    runId: 'versioned', task: 'versioned-task', category: 'bug', taskVersion: '2.0.0',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1 }],
  });
  result = invoke([versioned]);
  assert.equal(result.status, 0, result.stderr);

  const plan = JSON.parse(requireText(path.join(versioned, 'plan.json')));
  const manifestPath = path.join(versioned, plan.trials[0].manifest);
  const manifest = JSON.parse(requireText(manifestPath));
  manifest.taskVersion = '2.0.1';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  result = invoke([versioned]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /taskVersion.*does not match its plan/i);

  plan.taskVersion = 'latest';
  writeFileSync(path.join(versioned, 'plan.json'), JSON.stringify(plan));
  result = invoke([versioned]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /taskVersion.*semantic/i);
});

test('refuses to pair equal task revisions carrying different semantic task versions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-task-version-provenance-'));
  const baseline = createRun(root, {
    runId: 'version-one', task: 'same-task', category: 'bug', selectedArm: 'baseline',
    taskRevision: 'same-revision', taskVersion: '1.0.0',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 0 }],
  });
  const forge = createRun(root, {
    runId: 'version-two', task: 'same-task', category: 'bug', selectedArm: 'forge',
    taskRevision: 'same-revision', taskVersion: '2.0.0',
    cells: [{ arm: 'forge', repetition: 1, shippable: 1 }],
  });
  const result = invoke([baseline, forge]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /task revision|provenance|task version/i);
});

function campaignEpisodeSpecs() {
  return [1, 2, 3, 4, 5, 6].map((index) => ({
    index,
    id: `episode-0${index}`,
    baselineShippable: index % 2,
    forgeShippable: index <= 4 ? 1 : 0,
  }));
}

function campaignCellsFromSpecs(episodeSpecs, extras = {}) {
  return episodeSpecs.flatMap((episode) => [
    {
      arm: 'baseline',
      repetition: 1,
      episodeIndex: episode.index,
      episodeId: episode.id,
      shippable: episode.baselineShippable,
      ...extras,
    },
    {
      arm: 'forge',
      repetition: 1,
      episodeIndex: episode.index,
      episodeId: episode.id,
      shippable: episode.forgeShippable,
      ...extras,
    },
  ]);
}

test('campaign aggregation reports per-episode arm outcomes keyed by episode index', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-episodes-'));
  const episodeSpecs = campaignEpisodeSpecs();
  const directory = createRun(root, {
    runId: 'campaign-episodes',
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    campaignRevision: 'campaign-rev-1',
    campaign: {
      id: 'forgekit-campaign-v1',
      episodes: episodeSpecs.map((episode) => ({ id: episode.id, index: episode.index })),
    },
    cells: campaignCellsFromSpecs(episodeSpecs),
  });

  const result = invoke([directory]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const expectedIndexes = episodeSpecs.map((episode) => String(episode.index));
  assert.deepEqual(
    Object.keys(report.episodes).sort((left, right) => Number(left) - Number(right)),
    expectedIndexes,
  );
  for (const episode of episodeSpecs) {
    const entry = report.episodes[episode.index];
    assert.equal(entry.arms.baseline.outcomes.shippable.successes, episode.baselineShippable);
    assert.equal(entry.arms.forge.outcomes.shippable.successes, episode.forgeShippable);
    assert.equal(entry.arms.baseline.outcomes.shippable.observations, 1);
    assert.equal(entry.arms.forge.outcomes.shippable.observations, 1);
  }
});

test('accepts normalized schema version 2 with sibling counted fields and without requiring counts on binary records', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-schema-v2-'));
  const binary = createRun(root, {
    runId: 'schema-v2-binary',
    task: 'binary-task',
    category: 'bug',
    cells: [{
      arm: 'baseline',
      repetition: 1,
      shippable: 1,
      schemaVersion: 2,
      rewardShape: 'binary',
    }],
  });
  let result = invoke([binary]);
  assert.equal(result.status, 0, result.stderr);

  const counted = createRun(root, {
    runId: 'schema-v2-counted',
    task: 'counted-task',
    category: 'campaign',
    cells: [{
      arm: 'forge',
      repetition: 1,
      shippable: 1,
      schemaVersion: 2,
      rewardShape: 'counted',
      counts: {
        requirements_met: 7,
        requirements_total: 10,
        regression_met: 12,
        regression_total: 14,
      },
      falseCompletion: 1,
    }],
  });
  result = invoke([counted]);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects normalized schema versions other than 1 and 2', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-schema-v3-'));
  const directory = createRun(root, {
    runId: 'schema-v3',
    task: 'versioned-task',
    category: 'bug',
    cells: [{ arm: 'baseline', repetition: 1, shippable: 1, schemaVersion: 3 }],
  });
  const result = invoke([directory]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /schema version/i);
});

test('campaign aggregation reports per-episode paired deltas and incomplete pair counts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-episode-deltas-'));
  const incompleteIndex = 3;
  const episodeSpecs = [1, 2, 3, 4, 5, 6].map((index) => ({
    index,
    id: `episode-0${index}`,
    baselineShippable: index % 2,
    forgeShippable: index <= 4 ? 1 : 0,
    baselineCounts: {
      requirements_met: index,
      requirements_total: 10,
      regression_met: index,
      regression_total: 20,
    },
    forgeCounts: {
      requirements_met: index + 2,
      requirements_total: 10,
      regression_met: index + 1,
      regression_total: 20,
    },
  }));
  const cells = episodeSpecs.flatMap((episode) => {
    const counted = {
      schemaVersion: 2,
      rewardShape: 'counted',
      falseCompletion: 0,
    };
    const baseline = {
      arm: 'baseline',
      repetition: 1,
      episodeIndex: episode.index,
      episodeId: episode.id,
      shippable: episode.baselineShippable,
      counts: episode.baselineCounts,
      ...counted,
    };
    if (episode.index === incompleteIndex) {
      return [
        baseline,
        {
          arm: 'forge',
          repetition: 1,
          episodeIndex: episode.index,
          episodeId: episode.id,
          status: 'failed',
          error: 'Harbor exited with code 1',
        },
      ];
    }
    return [
      baseline,
      {
        arm: 'forge',
        repetition: 1,
        episodeIndex: episode.index,
        episodeId: episode.id,
        shippable: episode.forgeShippable,
        counts: episode.forgeCounts,
        ...counted,
      },
    ];
  });
  const directory = createRun(root, {
    runId: 'campaign-deltas',
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    campaignRevision: 'campaign-rev-1',
    campaign: {
      id: 'forgekit-campaign-v1',
      episodes: episodeSpecs.map((episode) => ({ id: episode.id, index: episode.index })),
    },
    cells,
  });

  const result = invoke([directory]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const completeSpecs = episodeSpecs.filter((episode) => episode.index !== incompleteIndex);
  const incompleteSpecs = episodeSpecs.filter((episode) => episode.index === incompleteIndex);

  for (const episode of completeSpecs) {
    const entry = report.episodes[episode.index];
    const expectedDelta = episode.forgeShippable - episode.baselineShippable;
    assert.equal(entry.pairs.complete, 1);
    assert.equal(entry.pairs.incomplete, 0);
    assert.equal(entry.pairs.outcomes.shippable.mean_delta, expectedDelta);
    assert.equal(
      entry.pairs.counts.requirements_met.mean_delta,
      episode.forgeCounts.requirements_met - episode.baselineCounts.requirements_met,
    );
    assert.equal(
      entry.arms.baseline.counts.requirements_met.mean,
      episode.baselineCounts.requirements_met,
    );
    assert.equal(
      entry.arms.forge.counts.requirements_met.mean,
      episode.forgeCounts.requirements_met,
    );
  }
  for (const episode of incompleteSpecs) {
    const entry = report.episodes[episode.index];
    assert.equal(entry.pairs.complete, 0);
    assert.equal(entry.pairs.incomplete, 1);
    assert.equal(entry.pairs.outcomes.shippable.mean_delta, null);
    assert.deepEqual(entry.pairs.incomplete_pairs, [{
      task: 'forgekit-campaign-v1',
      category: 'campaign',
      repetition: 1,
      episode_index: episode.index,
      present_arms: ['baseline'],
      missing_arms: ['forge'],
      arm_statuses: { baseline: 'verified', forge: 'failed' },
    }]);
    assert.equal(entry.arms.baseline.outcomes.shippable.successes, episode.baselineShippable);
    assert.equal(entry.arms.forge.outcomes.shippable.observations, 0);
  }
});

test('a not-attempted campaign episode is incomplete rather than a zero outcome', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-not-attempted-'));
  const directory = createRun(root, {
    runId: 'campaign-not-attempted',
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    campaignRevision: 'campaign-rev-1',
    campaign: {
      id: 'forgekit-campaign-v1',
      episodes: [{ id: 'episode-01', index: 1 }],
    },
    cells: [
      {
        arm: 'baseline',
        repetition: 1,
        episodeIndex: 1,
        episodeId: 'episode-01',
        shippable: 1,
      },
      {
        arm: 'forge',
        repetition: 1,
        episodeIndex: 1,
        episodeId: 'episode-01',
        status: 'not-attempted',
      },
    ],
  });
  const result = invoke([directory]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.episodes[1].pairs.complete, 0);
  assert.equal(report.episodes[1].pairs.incomplete, 1);
  assert.equal(report.episodes[1].arms.forge.outcomes.shippable.observations, 0);
  assert.equal(report.episodes[1].arms.forge.outcomes.shippable.successes, 0);
});

function oneEpisodeCampaign(root, {
  runId, selectedArm, campaignRevision, episodeRevision, arm, shippable,
}) {
  return createRun(root, {
    runId,
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    selectedArm,
    campaignRevision,
    campaign: { id: 'forgekit-campaign-v1', episodes: [{ id: 'episode-01', index: 1 }] },
    cells: [{
      arm,
      repetition: 1,
      episodeIndex: 1,
      episodeId: 'episode-01',
      episodeRevision,
      shippable,
    }],
  });
}

test('refuses mixed campaign revisions across run directories rather than pairing them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-mixed-campaign-rev-'));
  const baseline = oneEpisodeCampaign(root, {
    runId: 'campaign-rev-a', selectedArm: 'baseline', campaignRevision: 'campaign-rev-a',
    episodeRevision: 'episode-01-rev', arm: 'baseline', shippable: 0,
  });
  const forge = oneEpisodeCampaign(root, {
    runId: 'campaign-rev-b', selectedArm: 'forge', campaignRevision: 'campaign-rev-b',
    episodeRevision: 'episode-01-rev', arm: 'forge', shippable: 1,
  });
  const result = invoke([baseline, forge]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /campaign revision|provenance/i);
});

test('refuses mixed episode revisions across run directories rather than pairing them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-mixed-episode-rev-'));
  const baseline = oneEpisodeCampaign(root, {
    runId: 'episode-rev-a', selectedArm: 'baseline', campaignRevision: 'campaign-rev-same',
    episodeRevision: 'episode-01-rev-a', arm: 'baseline', shippable: 0,
  });
  const forge = oneEpisodeCampaign(root, {
    runId: 'episode-rev-b', selectedArm: 'forge', campaignRevision: 'campaign-rev-same',
    episodeRevision: 'episode-01-rev-b', arm: 'forge', shippable: 1,
  });
  const result = invoke([baseline, forge]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /episode revision|provenance/i);
});

test('pairs campaign arms whose episode revisions differ across episodes but match within each episode', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forgekit-aggregate-consistent-episode-rev-'));
  const episodeSpecs = [
    { index: 1, id: 'episode-01', revision: 'episode-01-hash', baselineShippable: 0, forgeShippable: 1 },
    { index: 2, id: 'episode-02', revision: 'episode-02-hash', baselineShippable: 1, forgeShippable: 1 },
  ];
  const cellsFor = (arm) => episodeSpecs.map((episode) => ({
    arm,
    repetition: 1,
    episodeIndex: episode.index,
    episodeId: episode.id,
    episodeRevision: episode.revision,
    shippable: arm === 'baseline' ? episode.baselineShippable : episode.forgeShippable,
  }));
  const baseline = createRun(root, {
    runId: 'consistent-base',
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    selectedArm: 'baseline',
    campaignRevision: 'campaign-rev-same',
    campaign: { id: 'forgekit-campaign-v1', episodes: episodeSpecs.map((episode) => ({ id: episode.id, index: episode.index })) },
    cells: cellsFor('baseline'),
  });
  const forge = createRun(root, {
    runId: 'consistent-forge',
    task: 'forgekit-campaign-v1',
    category: 'campaign',
    selectedArm: 'forge',
    campaignRevision: 'campaign-rev-same',
    campaign: { id: 'forgekit-campaign-v1', episodes: episodeSpecs.map((episode) => ({ id: episode.id, index: episode.index })) },
    cells: cellsFor('forge'),
  });
  const result = invoke([baseline, forge]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.episodes[1].pairs.complete, 1);
  assert.equal(report.episodes[2].pairs.complete, 1);
  assert.equal(report.episodes[1].pairs.outcomes.shippable.mean_delta, 1);
  assert.equal(report.episodes[2].pairs.outcomes.shippable.mean_delta, 0);
});
