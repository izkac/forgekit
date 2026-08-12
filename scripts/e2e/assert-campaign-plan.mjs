#!/usr/bin/env node
/**
 * Product-loop check for campaign dry-run plans: trial count, contiguous
 * episode indices per arm, seeded first-arm order, and no verifier source
 * bytes in any staged agent environment.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAMPAIGN_TASKS = path.join(REPO, 'evals/harbor/tasks/forgekit-campaign-v1');

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

function selectedArms(arm) {
  if (arm === 'both') return ['baseline', 'forge'];
  if (arm === 'baseline' || arm === 'forge') return [arm];
  fail(`plan.settings.arm is invalid: ${arm}`);
}

function expectedStartingArm(seed, campaignId, campaignRevision) {
  const startHash = createHash('sha256')
    .update(`${seed}\0${campaignId}\0${campaignRevision}`)
    .digest('hex');
  return Number.parseInt(startHash.slice(0, 2), 16) % 2 === 0 ? 'baseline' : 'forge';
}

function expectedArmOrders(startingArm, repetitions, arm) {
  if (arm !== 'both') {
    return Array.from({ length: repetitions }, () => [arm]);
  }
  const otherArm = startingArm === 'baseline' ? 'forge' : 'baseline';
  return Array.from({ length: repetitions }, (_, index) => (
    index % 2 === 0 ? [startingArm, otherArm] : [otherArm, startingArm]
  ));
}

async function listFiles(root) {
  const files = [];
  async function visit(current, relative = '') {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') fail(`missing directory: ${current}`);
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) files.push({ relative: childRelative, path: child });
      else fail(`unsupported entry: ${childRelative}`);
    }
  }
  await visit(root);
  return files;
}

async function verifierSourceBytes() {
  const buffers = [];
  let entries;
  try {
    entries = await readdir(CAMPAIGN_TASKS, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') fail(`campaign task tree is missing: ${CAMPAIGN_TASKS}`);
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^episode-\d{2}$/.test(entry.name)) continue;
    const testsDir = path.join(CAMPAIGN_TASKS, entry.name, 'tests');
    for (const file of await listFiles(testsDir)) {
      buffers.push(await readFile(file.path));
    }
  }
  if (buffers.length === 0) fail('no campaign verifier sources found');
  return buffers;
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

function assertSchedule(plan, seed) {
  const campaign = plan.campaign;
  if (campaign === null || typeof campaign !== 'object' || Array.isArray(campaign)) {
    fail('plan is missing campaign identity');
  }
  const campaignId = campaign.id;
  const campaignRevision = plan.taskRevision;
  if (typeof campaignId !== 'string' || campaignId.length === 0) fail('plan.campaign.id is missing');
  if (typeof campaignRevision !== 'string' || campaignRevision.length === 0) {
    fail('plan.taskRevision (campaign revision) is missing');
  }
  const arm = plan.settings?.arm;
  const repetitions = plan.settings?.repetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) fail('plan.settings.repetitions is invalid');
  const startingArm = expectedStartingArm(seed, campaignId, campaignRevision);
  const armOrders = expectedArmOrders(startingArm, repetitions, arm);
  if (arm === 'both') {
    if (plan.schedule?.startingArm !== startingArm) {
      fail(
        'recorded startingArm does not match the seeded hash',
        `expected ${startingArm}, got ${plan.schedule?.startingArm}`,
      );
    }
  } else if (plan.schedule?.startingArm !== null) {
    fail('single-arm schedule must record startingArm null');
  }
  if (JSON.stringify(plan.schedule?.armOrders) !== JSON.stringify(armOrders)) {
    fail(
      'recorded armOrders do not match the seeded schedule',
      `expected ${JSON.stringify(armOrders)}, got ${JSON.stringify(plan.schedule?.armOrders)}`,
    );
  }
}

function assertTrialCountAndOrder(plan) {
  const episodes = plan.campaign?.episodes;
  if (!Array.isArray(episodes) || episodes.length === 0) fail('plan.campaign.episodes is missing');
  const arms = selectedArms(plan.settings?.arm);
  const repetitions = plan.settings.repetitions;
  const expectedCount = episodes.length * arms.length * repetitions;
  const trials = plan.trials;
  if (!Array.isArray(trials) || trials.length === 0) fail('plan.trials is empty');
  if (trials.length !== expectedCount) {
    fail(
      `trial count does not match episodes × arms × repetitions`,
      `expected ${expectedCount} (${episodes.length} episodes × ${arms.length} arms × ${repetitions} repetitions), got ${trials.length}`,
    );
  }
  const expectedIndices = episodes.map((episode) => episode.index);
  for (const arm of arms) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const indices = trials
        .filter((trial) => trial.arm === arm && trial.repetition === repetition)
        .map((trial) => trial.episodeIndex)
        .sort((left, right) => left - right);
      if (JSON.stringify(indices) !== JSON.stringify(expectedIndices)) {
        fail(
          `episode indices for ${arm} repetition ${repetition} are not contiguous`,
          `expected ${JSON.stringify(expectedIndices)}, got ${JSON.stringify(indices)}`,
        );
      }
    }
  }
}

async function assertNoVerifierSources(runDir, trials, verifierBytes) {
  for (const trial of trials) {
    const relative = stagedPathFor(trial);
    const environment = path.join(runDir, relative, 'environment');
    const files = await listFiles(environment);
    for (const file of files) {
      const staged = await readFile(file.path);
      for (const verifier of verifierBytes) {
        if (Buffer.compare(staged, verifier) === 0) {
          fail(
            `verifier source bytes found in staged agent environment`,
            `${trial.arm} ${trial.episodeId} environment/${file.relative}`,
          );
        }
      }
    }
  }
}

async function main() {
  const { runsRoot, seed } = parseArgs(process.argv.slice(2));
  const { dir, plan } = await findNewestDryRun(runsRoot, seed);
  if (plan.settings?.seed !== seed && plan.seed !== seed) {
    fail(`newest dry-run seed does not match ${seed}`);
  }
  assertSchedule(plan, seed);
  assertTrialCountAndOrder(plan);
  const verifierBytes = await verifierSourceBytes();
  await assertNoVerifierSources(dir, plan.trials, verifierBytes);
  process.stdout.write(
    `campaign plan ok: ${plan.trials.length} trials, seed ${seed}, startingArm ${plan.schedule.startingArm}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`ASSERTION FAILED: ${error.message}\n`);
  process.exit(1);
});
