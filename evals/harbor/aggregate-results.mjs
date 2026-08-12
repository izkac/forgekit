#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const OUTCOME_METRICS = ['functional', 'regression', 'tests_unchanged', 'shippable'];
const INSTRUMENTATION_METRICS = [
  'wall_clock_seconds',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cost_usd',
  'retries',
];
const ARMS = ['baseline', 'forge'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function usage() {
  return 'Usage: node evals/harbor/aggregate-results.mjs --run-directory <directory> [--run-directory <directory> ...]\n';
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  const runDirectories = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--run-directory') throw new Error(`unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--run-directory requires a value');
    runDirectories.push(value);
    index += 1;
  }
  if (runDirectories.length === 0) throw new Error('at least one --run-directory is required');
  return { runDirectories };
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireSafeId(value, label) {
  requireString(value, label);
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireSemanticVersion(value, label) {
  requireString(value, label);
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} must be a semantic version`);
  return value;
}

function requireSchemaVersion(value, expected, label) {
  if (value !== expected) throw new Error(`${label} schema version must be ${expected}`);
}

function requireNormalizedSchemaVersion(value, label) {
  if (value !== 1 && value !== 2) throw new Error(`${label} schema version must be 1 or 2`);
}

const COUNT_FIELDS = ['requirements_met', 'requirements_total', 'regression_met', 'regression_total'];

function validateCounts(counts, label) {
  requireObject(counts, `${label}.counts`);
  const result = {};
  for (const name of COUNT_FIELDS) {
    const value = counts[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label}.counts.${name} must be a non-negative integer`);
    }
    result[name] = value;
  }
  if (result.requirements_met > result.requirements_total) {
    throw new Error(`${label}.counts.requirements_met must not exceed requirements_total`);
  }
  if (result.regression_met > result.regression_total) {
    throw new Error(`${label}.counts.regression_met must not exceed regression_total`);
  }
  return result;
}

function hasTraversal(candidate) {
  return candidate.split(/[\\/]/u).includes('..');
}

async function requireRunDirectory(candidate) {
  requireString(candidate, '--run-directory');
  if (hasTraversal(candidate)) throw new Error(`run directory traversal is not allowed: ${candidate}`);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    throw new Error(`could not inspect run directory ${candidate}: ${error.message}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`run directory must be a regular directory, not a symlink: ${candidate}`);
  }
  return realpath(candidate);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function requireRegularFile(runDirectory, reference, label) {
  requireString(reference, label);
  if (hasTraversal(reference)) throw new Error(`${label} must not contain path traversal`);
  const candidate = path.resolve(runDirectory, reference);
  if (!isInside(runDirectory, candidate)) throw new Error(`${label} must stay inside its run directory`);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    throw new Error(`could not inspect ${label} at ${candidate}: ${error.message}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  const resolved = await realpath(candidate);
  if (!isInside(runDirectory, resolved)) throw new Error(`${label} resolves outside its run directory`);
  return resolved;
}

async function readJsonFile(file, label) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${label} at ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${label} at ${file}: ${error.message}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function relevantSettings(settings, label) {
  requireObject(settings, label);
  const selected = {};
  for (const name of ['repetitions', 'concurrency', 'seed']) {
    if (!Object.hasOwn(settings, name)) throw new Error(`${label}.${name} is required`);
    selected[name] = settings[name];
  }
  if (!['baseline', 'forge', 'both'].includes(settings.arm)) throw new Error(`${label}.arm is invalid`);
  requirePositiveInteger(selected.repetitions, `${label}.repetitions`);
  requirePositiveInteger(selected.concurrency, `${label}.concurrency`);
  requireString(selected.seed, `${label}.seed`);
  return selected;
}

function planCohort(plan, label) {
  const settings = requireObject(plan.settings, `${label}.settings`);
  const treatment = stableValue(requireObject(settings.forgekitTreatment, `${label}.settings.forgekitTreatment`));
  return {
    agent: requireString(settings.agent, `${label}.settings.agent`),
    model: requireString(settings.model, `${label}.settings.model`),
    forgekit_treatment: treatment,
    harness_revision: requireString(plan.harnessRevision, `${label}.harnessRevision`),
    corpus: stableValue(requireObject(plan.corpus, `${label}.corpus`)),
    settings: relevantSettings(settings, `${label}.settings`),
  };
}

function assertSameCohort(expected, actual, runId) {
  for (const name of ['agent', 'model', 'forgekit_treatment', 'harness_revision', 'corpus', 'settings']) {
    if (!sameValue(expected[name], actual[name])) {
      throw new Error(`mixed cohort: ${name} differs in run ${runId}`);
    }
  }
}

function validatePlan(plan, runDirectory) {
  requireObject(plan, 'plan.json');
  requireSchemaVersion(plan.schemaVersion, 1, 'plan.json');
  const runId = requireSafeId(plan.runId, 'plan.json.runId');
  requireSafeId(plan.task, 'plan.json.task');
  if (Object.hasOwn(plan, 'taskVersion')) requireSemanticVersion(plan.taskVersion, 'plan.json.taskVersion');
  requireSafeId(plan.category, 'plan.json.category');
  requireString(plan.taskRevision, 'plan.json.taskRevision');
  requireString(plan.harnessRevision, 'plan.json.harnessRevision');
  requireObject(plan.images, 'plan.json.images');
  if (plan.dryRun !== false) throw new Error(`plan ${runId} must describe a completed non-dry run`);
  if (!['completed', 'completed-with-failures'].includes(plan.status)) throw new Error(`plan ${runId}.status must be terminal`);
  if (!Array.isArray(plan.trials) || plan.trials.length === 0) throw new Error(`plan ${runId}.trials must be a non-empty array`);
  if (Object.hasOwn(plan, 'runDirectory')) {
    requireString(plan.runDirectory, `plan ${runId}.runDirectory`);
    const declared = path.resolve(plan.runDirectory);
    if (declared !== runDirectory) throw new Error(`plan ${runId}.runDirectory does not match --run-directory`);
  }
  return { runId, cohort: planCohort(plan, `plan ${runId}`) };
}

function assertManifestMatchesPlan(manifest, plan, trialEntry, cohort, label) {
  requireObject(manifest, label);
  requireSchemaVersion(manifest.schemaVersion, 1, label);
  requireSafeId(manifest.runId, `${label}.runId`);
  requireSafeId(manifest.trialId, `${label}.trialId`);
  requireSafeId(manifest.task, `${label}.task`);
  const planHasTaskVersion = Object.hasOwn(plan, 'taskVersion');
  const manifestHasTaskVersion = Object.hasOwn(manifest, 'taskVersion');
  if (planHasTaskVersion !== manifestHasTaskVersion) {
    throw new Error(`${label}.taskVersion does not match its plan`);
  }
  if (manifestHasTaskVersion) {
    requireSemanticVersion(manifest.taskVersion, `${label}.taskVersion`);
    if (manifest.taskVersion !== plan.taskVersion) throw new Error(`${label}.taskVersion does not match its plan`);
  }
  requireSafeId(manifest.category, `${label}.category`);
  requireString(manifest.taskRevision, `${label}.taskRevision`);
  requireString(manifest.harnessRevision, `${label}.harnessRevision`);
  requireObject(manifest.corpus, `${label}.corpus`);
  requireObject(manifest.images, `${label}.images`);
  requireObject(manifest.harbor, `${label}.harbor`);
  requireString(manifest.harbor.executable, `${label}.harbor.executable`);
  if (!Array.isArray(manifest.harbor.argv)) throw new Error(`${label}.harbor.argv must be an array`);
  requirePositiveInteger(manifest.repetition, `${label}.repetition`);
  if (!ARMS.includes(manifest.arm)) throw new Error(`${label}.arm must be baseline or forge`);
  if (!['verified', 'failed', 'not-attempted'].includes(manifest.status)) {
    throw new Error(`${label}.status must be verified, failed, or not-attempted`);
  }
  if (manifest.status === 'failed') requireString(manifest.error, `${label}.error`);

  const campaignTrial = Object.hasOwn(trialEntry, 'episodeIndex') || Object.hasOwn(manifest, 'episodeIndex');
  if (campaignTrial) {
    requireSafeId(manifest.episodeId, `${label}.episodeId`);
    requirePositiveInteger(manifest.episodeIndex, `${label}.episodeIndex`);
    if (manifest.episodeId !== trialEntry.episodeId) throw new Error(`${label}.episodeId does not match its plan`);
    if (manifest.episodeIndex !== trialEntry.episodeIndex) throw new Error(`${label}.episodeIndex does not match its plan`);
  }

  const matches = [
    ['runId', plan.runId], ['task', plan.task], ['category', plan.category],
    ...(campaignTrial ? [] : [['taskRevision', plan.taskRevision]]),
    ['harnessRevision', plan.harnessRevision],
    ['trialId', trialEntry.trialId], ['arm', trialEntry.arm], ['repetition', trialEntry.repetition],
    ['status', trialEntry.status], ['scheduleIndex', trialEntry.scheduleIndex],
    ['executionIndex', trialEntry.executionIndex], ['armOrdinal', trialEntry.armOrdinal],
  ];
  for (const [name, expected] of matches) {
    if (manifest[name] !== expected) throw new Error(`${label}.${name} does not match its plan`);
  }
  if (!sameValue(manifest.armOrder, trialEntry.armOrder)) throw new Error(`${label}.armOrder does not match its plan`);
  if (!sameValue(manifest.corpus, plan.corpus)) throw new Error(`${label}.corpus does not match its plan`);
  if (!sameValue(manifest.images, plan.images)) throw new Error(`${label}.images does not match its plan`);
  if (manifest.agent !== cohort.agent) throw new Error(`${label}.agent does not match its cohort`);
  if (manifest.model !== cohort.model) throw new Error(`${label}.model does not match its cohort`);
  if (!sameValue(manifest.forgekitTreatment, cohort.forgekit_treatment)) {
    throw new Error(`${label}.forgekitTreatment does not match its cohort`);
  }
  const manifestSettings = requireObject(manifest.settings, `${label}.settings`);
  for (const name of ['repetitions', 'concurrency']) {
    if (manifestSettings[name] !== cohort.settings[name]) throw new Error(`${label}.settings.${name} does not match its cohort`);
  }
  if (manifest.seed !== cohort.settings.seed) throw new Error(`${label}.seed does not match its cohort`);
}

function validateNormalized(record, manifest, label) {
  requireObject(record, label);
  requireNormalizedSchemaVersion(record.schema_version, label);
  if (record.arm !== manifest.arm) throw new Error(`${label}.arm does not match its manifest`);
  if (record.task !== manifest.task) throw new Error(`${label}.task does not match its manifest`);
  if (record.trial !== manifest.repetition) throw new Error(`${label}.trial does not match its manifest`);
  const outcome = requireObject(record.outcome, `${label}.outcome`);
  for (const metric of OUTCOME_METRICS) {
    if (outcome[metric] !== 0 && outcome[metric] !== 1) {
      throw new Error(`${label}.outcome.${metric} must be binary (0 or 1)`);
    }
  }
  if (outcome.shippable === 1 && OUTCOME_METRICS.slice(0, 3).some((metric) => outcome[metric] !== 1)) {
    throw new Error(`${label}.outcome.shippable contradicts required outcome metrics`);
  }

  const instrumentation = requireObject(record.instrumentation, `${label}.instrumentation`);
  if (typeof instrumentation.available !== 'boolean') throw new Error(`${label}.instrumentation.available must be boolean`);
  const harbor = requireObject(instrumentation.harbor, `${label}.instrumentation.harbor`);
  if (typeof harbor.available !== 'boolean') throw new Error(`${label}.instrumentation.harbor.available must be boolean`);
  const numeric = {};
  for (const metric of INSTRUMENTATION_METRICS) {
    const value = harbor[metric];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${label}.instrumentation.harbor.${metric} must be a non-negative finite number or null`);
    }
    numeric[metric] = value;
  }
  const extra = {};
  if (Object.hasOwn(record, 'counts')) extra.counts = validateCounts(record.counts, label);
  if (Object.hasOwn(record, 'false_completion')) {
    if (record.false_completion !== 0 && record.false_completion !== 1) {
      throw new Error(`${label}.false_completion must be binary (0 or 1)`);
    }
    extra.false_completion = record.false_completion;
  }
  if (Object.hasOwn(record, 'reward_shape')) {
    if (record.reward_shape !== 'binary' && record.reward_shape !== 'counted') {
      throw new Error(`${label}.reward_shape must be binary or counted`);
    }
    extra.reward_shape = record.reward_shape;
  }
  return { outcome, instrumentation: numeric, ...extra };
}

async function readRun(candidate) {
  const runDirectory = await requireRunDirectory(candidate);
  const planFile = await requireRegularFile(runDirectory, 'plan.json', 'plan.json');
  const plan = await readJsonFile(planFile, 'plan.json');
  const { runId, cohort } = validatePlan(plan, runDirectory);
  const observations = [];

  for (let index = 0; index < plan.trials.length; index += 1) {
    const trialEntry = requireObject(plan.trials[index], `plan ${runId}.trials[${index}]`);
    requireSafeId(trialEntry.trialId, `plan ${runId}.trials[${index}].trialId`);
    if (!ARMS.includes(trialEntry.arm)) throw new Error(`plan ${runId}.trials[${index}].arm is invalid`);
    requirePositiveInteger(trialEntry.repetition, `plan ${runId}.trials[${index}].repetition`);
    requirePositiveInteger(trialEntry.scheduleIndex, `plan ${runId}.trials[${index}].scheduleIndex`);
    requirePositiveInteger(trialEntry.executionIndex, `plan ${runId}.trials[${index}].executionIndex`);
    requirePositiveInteger(trialEntry.armOrdinal, `plan ${runId}.trials[${index}].armOrdinal`);
    if (!Array.isArray(trialEntry.armOrder)) throw new Error(`plan ${runId}.trials[${index}].armOrder must be an array`);
    const campaignTrial = Object.hasOwn(trialEntry, 'episodeIndex');
    if (campaignTrial) {
      requireSafeId(trialEntry.episodeId, `plan ${runId}.trials[${index}].episodeId`);
      requirePositiveInteger(trialEntry.episodeIndex, `plan ${runId}.trials[${index}].episodeIndex`);
    }
    const manifestFile = await requireRegularFile(runDirectory, trialEntry.manifest, `manifest for ${trialEntry.trialId}`);
    const manifest = await readJsonFile(manifestFile, `manifest for ${trialEntry.trialId}`);
    assertManifestMatchesPlan(manifest, plan, trialEntry, cohort, `manifest ${trialEntry.trialId}`);
    let values = { outcome: null, instrumentation: null };
    if (manifest.status === 'verified') {
      const normalizedFile = await requireRegularFile(runDirectory, manifest.normalizedResult, `normalized result for ${trialEntry.trialId}`);
      const normalized = await readJsonFile(normalizedFile, `normalized result for ${trialEntry.trialId}`);
      values = validateNormalized(normalized, manifest, `normalized result ${trialEntry.trialId}`);
    }
    observations.push({
      run_id: runId,
      task: manifest.task,
      category: manifest.category,
      repetition: manifest.repetition,
      arm: manifest.arm,
      status: manifest.status,
      ...(campaignTrial
        ? { episode_id: manifest.episodeId, episode_index: manifest.episodeIndex }
        : {}),
      provenance: stableValue({
        task_revision: manifest.taskRevision,
        ...(campaignTrial
          ? {
            campaign_revision: plan.taskRevision,
            episode_id: manifest.episodeId,
            episode_index: manifest.episodeIndex,
            episode_revision: manifest.taskRevision,
          }
          : {}),
        ...(Object.hasOwn(manifest, 'taskVersion') ? { task_version: manifest.taskVersion } : {}),
        corpus: manifest.corpus,
        images: manifest.images,
      }),
      ...values,
    });
  }
  return { runDirectory, runId, cohort, observations };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function operationSummary(observations) {
  return {
    planned: observations.length,
    verified: observations.filter((observation) => observation.status === 'verified').length,
    failed: observations.filter((observation) => observation.status === 'failed').length,
  };
}

function countedMetricsSummary(observations) {
  const verified = observations.filter((observation) => observation.counts);
  if (verified.length === 0) return undefined;
  return Object.fromEntries(COUNT_FIELDS.map((field) => {
    const values = verified.map((observation) => observation.counts[field]);
    return [field, { observations: values.length, mean: mean(values) }];
  }));
}

function armSummary(observations) {
  const verified = observations.filter((observation) => observation.outcome !== null);
  const outcomes = {};
  for (const metric of OUTCOME_METRICS) {
    const successes = verified.reduce((sum, observation) => sum + observation.outcome[metric], 0);
    outcomes[metric] = {
      observations: verified.length,
      successes,
      rate: verified.length === 0 ? null : successes / verified.length,
    };
  }
  const instrumentation = {};
  for (const metric of INSTRUMENTATION_METRICS) {
    const values = verified.map((observation) => observation.instrumentation[metric]).filter((value) => value !== null);
    instrumentation[metric] = {
      observations: values.length,
      missing: verified.length - values.length,
      mean: mean(values),
    };
  }
  const counts = countedMetricsSummary(verified);
  return {
    observations: verified.length,
    operations: operationSummary(observations),
    outcomes,
    instrumentation,
    ...(counts === undefined ? {} : { counts }),
  };
}

function pairKey(observation) {
  return observation.episode_index == null
    ? `${observation.task}\0${observation.repetition}`
    : `${observation.task}\0${observation.repetition}\0${observation.episode_index}`;
}

function taskLevelProvenance(observation) {
  if (observation.episode_index == null) return observation.provenance;
  return {
    campaign_revision: observation.provenance.campaign_revision,
    corpus: observation.provenance.corpus,
    images: observation.provenance.images,
  };
}

function episodeLevelProvenance(observation) {
  return {
    episode_id: observation.episode_id,
    episode_revision: observation.provenance.episode_revision,
    ...(Object.hasOwn(observation.provenance, 'task_version')
      ? { task_version: observation.provenance.task_version }
      : {}),
  };
}

function sortedPairCells(observations) {
  const cells = new Map();
  const taskProvenance = new Map();
  const episodeProvenance = new Map();
  for (const observation of observations) {
    const expected = taskProvenance.get(observation.task);
    const actual = taskLevelProvenance(observation);
    if (expected && !sameValue(expected, actual)) {
      throw new Error(
        observation.episode_index == null
          ? `task revision or provenance differs across repetitions of task ${observation.task}`
          : `campaign revision or provenance differs for campaign ${observation.task}`,
      );
    }
    taskProvenance.set(observation.task, actual);
    if (observation.episode_index != null) {
      const episodeKey = `${observation.task}\0${observation.episode_index}`;
      const expectedEpisode = episodeProvenance.get(episodeKey);
      const episodeActual = episodeLevelProvenance(observation);
      if (expectedEpisode && !sameValue(expectedEpisode, episodeActual)) {
        throw new Error(
          `episode revision or provenance differs for campaign ${observation.task} episode ${observation.episode_index}`,
        );
      }
      episodeProvenance.set(episodeKey, episodeActual);
    }
    const key = pairKey(observation);
    if (!cells.has(key)) {
      cells.set(key, {
        task: observation.task,
        category: observation.category,
        repetition: observation.repetition,
        ...(observation.episode_index == null
          ? {}
          : { episode_index: observation.episode_index, episode_id: observation.episode_id }),
      });
    }
    const cell = cells.get(key);
    if (cell.category !== observation.category) throw new Error(`task ${observation.task} has inconsistent categories`);
    const mate = ARMS.map((arm) => cell[arm]).find(Boolean);
    if (mate && !sameValue(mate.provenance, observation.provenance)) {
      throw new Error(
        observation.episode_index == null
          ? `task revision or provenance differs for task ${observation.task} repetition ${observation.repetition}`
          : `episode revision or provenance differs for campaign ${observation.task} episode ${observation.episode_index} repetition ${observation.repetition}`,
      );
    }
    if (Object.hasOwn(cell, observation.arm)) {
      throw new Error(
        observation.episode_index == null
          ? `duplicate cell for task ${observation.task} repetition ${observation.repetition} arm ${observation.arm}`
          : `duplicate cell for task ${observation.task} repetition ${observation.repetition} arm ${observation.arm} episode ${observation.episode_index}`,
      );
    }
    cell[observation.arm] = observation;
  }
  return [...cells.values()].sort(
    (left, right) => left.task.localeCompare(right.task)
      || left.repetition - right.repetition
      || (left.episode_index ?? 0) - (right.episode_index ?? 0),
  );
}

function pairSummary(observations) {
  const cells = sortedPairCells(observations);
  const complete = cells.filter((cell) => cell.baseline?.outcome && cell.forge?.outcome);
  const incomplete = cells.filter((cell) => !cell.baseline?.outcome || !cell.forge?.outcome).map((cell) => {
    const present = ARMS.filter((arm) => cell[arm]?.outcome);
    return {
      task: cell.task,
      category: cell.category,
      repetition: cell.repetition,
      ...(cell.episode_index == null ? {} : { episode_index: cell.episode_index }),
      present_arms: present,
      missing_arms: ARMS.filter((arm) => !cell[arm]?.outcome),
      arm_statuses: Object.fromEntries(ARMS.filter((arm) => cell[arm]).map((arm) => [arm, cell[arm].status])),
    };
  });
  const outcomes = {};
  for (const metric of OUTCOME_METRICS) {
    const deltas = complete.map((cell) => cell.forge.outcome[metric] - cell.baseline.outcome[metric]);
    outcomes[metric] = {
      pairs: complete.length,
      baseline_successes: complete.reduce((sum, cell) => sum + cell.baseline.outcome[metric], 0),
      forge_successes: complete.reduce((sum, cell) => sum + cell.forge.outcome[metric], 0),
      mean_delta: mean(deltas),
      wins: deltas.filter((delta) => delta > 0).length,
      losses: deltas.filter((delta) => delta < 0).length,
      ties: deltas.filter((delta) => delta === 0).length,
    };
  }
  const instrumentation = {};
  for (const metric of INSTRUMENTATION_METRICS) {
    const usable = complete.filter((cell) => cell.baseline.instrumentation[metric] !== null && cell.forge.instrumentation[metric] !== null);
    instrumentation[metric] = {
      pairs: usable.length,
      missing_pairs: complete.length - usable.length,
      missing_baseline: complete.filter((cell) => cell.baseline.instrumentation[metric] === null).length,
      missing_forge: complete.filter((cell) => cell.forge.instrumentation[metric] === null).length,
      baseline_mean: mean(usable.map((cell) => cell.baseline.instrumentation[metric])),
      forge_mean: mean(usable.map((cell) => cell.forge.instrumentation[metric])),
      mean_delta: mean(usable.map((cell) => cell.forge.instrumentation[metric] - cell.baseline.instrumentation[metric])),
    };
  }
  const countedPairs = complete.filter((cell) => cell.baseline.counts && cell.forge.counts);
  const counts = countedPairs.length === 0
    ? undefined
    : Object.fromEntries(COUNT_FIELDS.map((field) => {
      const deltas = countedPairs.map((cell) => cell.forge.counts[field] - cell.baseline.counts[field]);
      return [field, { pairs: countedPairs.length, mean_delta: mean(deltas) }];
    }));
  return {
    complete: complete.length,
    incomplete: incomplete.length,
    incomplete_pairs: incomplete,
    outcomes,
    instrumentation,
    ...(counts === undefined ? {} : { counts }),
  };
}

function armsSummary(observations) {
  return Object.fromEntries(ARMS.map((arm) => [arm, armSummary(observations.filter((item) => item.arm === arm))]));
}

function groupedSummaries(observations, property) {
  const names = [...new Set(observations.map((observation) => observation[property]))].sort();
  return Object.fromEntries(names.map((name) => {
    const selected = observations.filter((observation) => observation[property] === name);
    const summary = { arms: armsSummary(selected), pairs: pairSummary(selected) };
    if (property === 'task') summary.category = selected[0].category;
    return [name, summary];
  }));
}

function episodeSummaries(observations) {
  const selected = observations.filter((observation) => observation.episode_index != null);
  if (selected.length === 0) return undefined;
  const indexes = [...new Set(selected.map((observation) => observation.episode_index))]
    .sort((left, right) => left - right);
  return Object.fromEntries(indexes.map((index) => {
    const episode = selected.filter((observation) => observation.episode_index === index);
    return [index, {
      episode_index: index,
      episode_id: episode[0].episode_id,
      arms: armsSummary(episode),
      pairs: pairSummary(episode),
    }];
  }));
}

async function aggregate(runDirectories) {
  const runs = [];
  for (const directory of runDirectories) runs.push(await readRun(directory));
  const cohort = runs[0].cohort;
  for (const run of runs.slice(1)) assertSameCohort(cohort, run.cohort, run.runId);
  const observations = runs.flatMap((run) => run.observations);
  // Validate duplicates across run-directory boundaries before producing any report.
  sortedPairCells(observations);
  const tasks = groupedSummaries(observations, 'task');
  const episodes = episodeSummaries(observations);
  const taskDeltas = Object.values(tasks)
    .map((summary) => summary.pairs.outcomes.shippable.mean_delta)
    .filter((value) => value !== null);
  return {
    schema_version: 1,
    cohort,
    run_ids: runs.map((run) => run.runId),
    observations: observations.filter((observation) => observation.outcome !== null).length,
    operations: operationSummary(observations),
    arms: armsSummary(observations),
    categories: groupedSummaries(observations, 'category'),
    tasks,
    ...(episodes === undefined ? {} : { episodes }),
    pairs: pairSummary(observations),
    primary: {
      endpoint: 'shippable',
      estimand: 'equal-task-weighted mean of within-task paired deltas',
      complete_tasks: taskDeltas.length,
      mean_delta: mean(taskDeltas),
    },
    limitations: [
      'Paired deltas include complete task/repetition pairs only; incomplete pairs and missing instrumentation are excluded.',
      'Published tasks are held out through a separate verifier boundary, not private or contamination-free.',
      'This initial corpus is not statistically representative, and observed differences are not necessarily causal, especially with concurrent execution.',
    ],
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const report = await aggregate(options.runDirectories);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`aggregate-results: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
