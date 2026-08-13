#!/usr/bin/env node
/**
 * Product-loop check for campaign dry-run instructions: Forge-arm
 * instruction.md must state the trial is unattended; baseline must not,
 * and must not mention Forge workflow.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const UNATTENDED = /unattended/i;
const NO_HUMAN_OPERATOR = /no human operator/i;
const NO_CLARIFYING_QUESTION = /never end (?:a |your )turn with a clarifying question/i;
const FORGE_WORKFLOW = /Forge workflow/i;

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let runsRoot = null;
  let seed = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--runs-root') {
      if (value === undefined || value.startsWith('--')) fail('--runs-root requires a value');
      runsRoot = value;
      index += 1;
      continue;
    }
    if (flag === '--seed') {
      if (value === undefined || value.startsWith('--')) fail('--seed requires a value');
      seed = value;
      index += 1;
      continue;
    }
    fail(`unknown option: ${flag}`);
  }
  if (runsRoot === null) fail('--runs-root is required');
  if (seed === null) fail('--seed is required');
  return { runsRoot: path.resolve(runsRoot), seed };
}

async function findNewestDryRun(runsRoot, seed) {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') fail(`runs root does not exist: ${runsRoot}`);
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const planPath = path.join(dir, 'plan.json');
    let info;
    try {
      info = await stat(planPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) continue;
    let plan;
    try {
      plan = JSON.parse(await readFile(planPath, 'utf8'));
    } catch {
      fail(`plan.json is not valid JSON: ${planPath}`);
    }
    const planSeed = plan.seed ?? plan.settings?.seed;
    if (plan.dryRun === true && planSeed === seed) {
      matches.push({ dir, plan, mtime: info.mtimeMs });
    }
  }
  if (matches.length === 0) fail(`no dry-run plan found for seed ${seed} under ${runsRoot}`);
  matches.sort((left, right) => right.mtime - left.mtime || right.dir.localeCompare(left.dir));
  return matches[0];
}

function stagedPathFor(trial) {
  if (!Array.isArray(trial.harborArgv)) fail(`trial ${trial.trialId} is missing harborArgv`);
  const index = trial.harborArgv.indexOf('--path');
  if (index < 0 || trial.harborArgv[index + 1] === undefined) {
    fail(`trial ${trial.trialId} is missing --path in harborArgv`);
  }
  return trial.harborArgv[index + 1];
}

async function readStagedInstruction(runDir, trial) {
  const instructionPath = path.join(runDir, stagedPathFor(trial), 'instruction.md');
  try {
    return await readFile(instructionPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`missing staged instruction.md for ${trial.arm} ${trial.trialId}`, instructionPath);
    }
    throw error;
  }
}

function assertForgeInstruction(trial, instruction) {
  if (!UNATTENDED.test(instruction)) {
    fail(`Forge instruction is missing unattended rule`, trial.trialId);
  }
  if (!NO_HUMAN_OPERATOR.test(instruction)) {
    fail(`Forge instruction is missing no-human-operator rule`, trial.trialId);
  }
  if (!NO_CLARIFYING_QUESTION.test(instruction)) {
    fail(`Forge instruction is missing clarifying-question rule`, trial.trialId);
  }
}

function assertBaselineInstruction(trial, instruction) {
  if (UNATTENDED.test(instruction)) {
    fail(`baseline instruction contains unattended rule`, trial.trialId);
  }
  if (NO_HUMAN_OPERATOR.test(instruction)) {
    fail(`baseline instruction contains unattended operator rule`, trial.trialId);
  }
  if (NO_CLARIFYING_QUESTION.test(instruction)) {
    fail(`baseline instruction contains unattended clarifying-question rule`, trial.trialId);
  }
  if (FORGE_WORKFLOW.test(instruction)) {
    fail(`baseline instruction mentions Forge workflow`, trial.trialId);
  }
}

async function main() {
  const { runsRoot, seed } = parseArgs(process.argv.slice(2));
  const { dir, plan } = await findNewestDryRun(runsRoot, seed);
  const trials = plan.trials;
  if (!Array.isArray(trials) || trials.length === 0) fail('plan.trials is empty');

  const forgeTrials = trials.filter((trial) => trial.arm === 'forge');
  const baselineTrials = trials.filter((trial) => trial.arm === 'baseline');
  if (forgeTrials.length === 0) fail('plan has no forge trials');
  if (baselineTrials.length === 0) fail('plan has no baseline trials');

  for (const trial of forgeTrials) {
    assertForgeInstruction(trial, await readStagedInstruction(dir, trial));
  }
  for (const trial of baselineTrials) {
    assertBaselineInstruction(trial, await readStagedInstruction(dir, trial));
  }

  process.stdout.write(
    `unattended forge instruction ok: ${forgeTrials.length} forge, ${baselineTrials.length} baseline, seed ${seed}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`ASSERTION FAILED: ${error.message}\n`);
  process.exit(1);
});
