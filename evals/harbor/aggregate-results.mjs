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

function requireSchemaVersion(value, expected, label) {
  if (value !== expected) throw new Error(`${label} schema version must be ${expected}`);
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
    settings: relevantSettings(settings, `${label}.settings`),
  };
}

function assertSameCohort(expected, actual, runId) {
  for (const name of ['agent', 'model', 'forgekit_treatment', 'harness_revision', 'settings']) {
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
  requireSafeId(plan.category, 'plan.json.category');
  requireString(plan.taskRevision, 'plan.json.taskRevision');
  requireString(plan.harnessRevision, 'plan.json.harnessRevision');
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
  requireSafeId(manifest.category, `${label}.category`);
  requireString(manifest.taskRevision, `${label}.taskRevision`);
  requireString(manifest.harnessRevision, `${label}.harnessRevision`);
  requirePositiveInteger(manifest.repetition, `${label}.repetition`);
  if (!ARMS.includes(manifest.arm)) throw new Error(`${label}.arm must be baseline or forge`);
  if (!['verified', 'failed'].includes(manifest.status)) throw new Error(`${label}.status must be verified or failed`);
  if (manifest.status === 'failed') requireString(manifest.error, `${label}.error`);

  const matches = [
    ['runId', plan.runId], ['task', plan.task], ['category', plan.category],
    ['taskRevision', plan.taskRevision], ['harnessRevision', plan.harnessRevision],
    ['trialId', trialEntry.trialId], ['arm', trialEntry.arm], ['repetition', trialEntry.repetition],
    ['status', trialEntry.status],
  ];
  for (const [name, expected] of matches) {
    if (manifest[name] !== expected) throw new Error(`${label}.${name} does not match its plan`);
  }
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
  requireSchemaVersion(record.schema_version, 1, label);
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
  return { outcome, instrumentation: numeric };
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
      ...values,
    });
  }
  return { runDirectory, runId, cohort, observations };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function armSummary(observations) {
  const outcomes = {};
  for (const metric of OUTCOME_METRICS) {
    const successes = observations.reduce((sum, observation) => sum + observation.outcome[metric], 0);
    outcomes[metric] = {
      observations: observations.filter((observation) => observation.outcome !== null).length,
      successes,
      rate: observations.length === 0 ? null : successes / observations.length,
    };
  }
  const instrumentation = {};
  for (const metric of INSTRUMENTATION_METRICS) {
    const values = observations.map((observation) => observation.instrumentation[metric]).filter((value) => value !== null);
    instrumentation[metric] = {
      observations: values.length,
      missing: observations.length - values.length,
      mean: mean(values),
    };
  }
  return { observations: observations.length, outcomes, instrumentation };
}

function pairKey(observation) {
  return `${observation.task}\0${observation.repetition}`;
}

function sortedPairCells(observations) {
  const cells = new Map();
  for (const observation of observations) {
    const key = pairKey(observation);
    if (!cells.has(key)) cells.set(key, { task: observation.task, category: observation.category, repetition: observation.repetition });
    const cell = cells.get(key);
    if (cell.category !== observation.category) throw new Error(`task ${observation.task} has inconsistent categories`);
    if (Object.hasOwn(cell, observation.arm)) {
      throw new Error(`duplicate cell for task ${observation.task} repetition ${observation.repetition} arm ${observation.arm}`);
    }
    cell[observation.arm] = observation;
  }
  return [...cells.values()].sort((left, right) => left.task.localeCompare(right.task) || left.repetition - right.repetition);
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
      present_arms: present,
      missing_arms: ARMS.filter((arm) => !cell[arm]?.outcome),
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
  return { complete: complete.length, incomplete: incomplete.length, incomplete_pairs: incomplete, outcomes, instrumentation };
}

function armsSummary(observations) {
  return Object.fromEntries(ARMS.map((arm) => [arm, armSummary(observations.filter((item) => item.arm === arm && item.outcome !== null))]));
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

async function aggregate(runDirectories) {
  const runs = [];
  for (const directory of runDirectories) runs.push(await readRun(directory));
  const cohort = runs[0].cohort;
  for (const run of runs.slice(1)) assertSameCohort(cohort, run.cohort, run.runId);
  const observations = runs.flatMap((run) => run.observations);
  // Validate duplicates across run-directory boundaries before producing any report.
  sortedPairCells(observations);
  const tasks = groupedSummaries(observations, 'task');
  const taskDeltas = Object.values(tasks)
    .map((summary) => summary.pairs.outcomes.shippable.mean_delta)
    .filter((value) => value !== null);
  return {
    schema_version: 1,
    cohort,
    run_ids: runs.map((run) => run.runId),
    observations: observations.filter((observation) => observation.outcome !== null).length,
    arms: armsSummary(observations),
    categories: groupedSummaries(observations, 'category'),
    tasks,
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
