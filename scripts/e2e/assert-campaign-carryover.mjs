#!/usr/bin/env node
/**
 * Product-loop check for campaign dry-run carryover: episode N+1's staged
 * app is inherited from episode N of the same arm, and arms do not share
 * files that exist in only one arm's carried app.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CARRYOVER_MARKER } from '../../evals/harbor/tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs';

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

function stagedPathFor(trial) {
  if (!Array.isArray(trial.harborArgv)) fail(`trial ${trial.trialId} is missing harborArgv`);
  const index = trial.harborArgv.indexOf('--path');
  if (index < 0 || trial.harborArgv[index + 1] === undefined) {
    fail(`trial ${trial.trialId} is missing --path in harborArgv`);
  }
  return trial.harborArgv[index + 1];
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

async function appFileMap(appDir) {
  const files = new Map();
  async function visit(current, relative = '') {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') fail(`missing staged app: ${appDir}`);
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        const bytes = await readFile(child);
        files.set(childRelative, createHash('sha256').update(bytes).digest('hex'));
      } else fail(`unsupported app entry: ${childRelative}`);
    }
  }
  await visit(appDir);
  return files;
}

function withoutMarker(files) {
  const copy = new Map(files);
  copy.delete(CARRYOVER_MARKER);
  return copy;
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, hash] of left) {
    if (right.get(name) !== hash) return false;
  }
  return true;
}

function trialApp(runDir, trial) {
  return path.join(runDir, stagedPathFor(trial), 'environment', 'app');
}

function groupByArmRepetition(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.arm}:${trial.repetition}`;
    const list = groups.get(key) ?? [];
    list.push(trial);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => left.episodeIndex - right.episodeIndex);
  }
  return groups;
}

function originOnlyNames(originMaps, arm) {
  const own = withoutMarker(originMaps.get(arm));
  const names = [];
  for (const name of own.keys()) {
    const shared = [...originMaps.entries()].some(([otherArm, files]) => (
      otherArm !== arm && withoutMarker(files).has(name)
    ));
    if (!shared) names.push(name);
  }
  return names;
}

function assertArmIsolation(originMaps, carriedByArm) {
  if (originMaps.size < 2) return;
  for (const arm of originMaps.keys()) {
    for (const name of originOnlyNames(originMaps, arm)) {
      for (const [otherArm, carried] of carriedByArm) {
        if (otherArm === arm) continue;
        if (carried.has(name)) {
          fail(
            `arms share a file that exists in only one arm's carried app: ${name}`,
            `${arm}-only file appeared in ${otherArm}`,
          );
        }
      }
    }
  }
}

async function main() {
  const { runsRoot, seed } = parseArgs(process.argv.slice(2));
  const { dir, plan } = await findNewestDryRun(runsRoot, seed);
  const trials = plan.trials;
  if (!Array.isArray(trials) || trials.length === 0) fail('plan.trials is empty');

  const groups = groupByArmRepetition(trials);
  const originByArm = new Map();
  const carriedByArm = new Map();
  const chainMaps = [];
  for (const [key, chain] of groups) {
    if (chain.length < 2) fail(`arm chain ${key} has no episode after the first`);
    const maps = [];
    for (const trial of chain) maps.push(await appFileMap(trialApp(dir, trial)));
    chainMaps.push({ key, chain, maps });
    const arm = chain[0].arm;
    const existingOrigin = originByArm.get(arm);
    if (existingOrigin === undefined) originByArm.set(arm, maps[0]);
    else if (!mapsEqual(existingOrigin, maps[0])) {
      fail(`episode 1 app for ${arm} differs across repetitions`);
    }
    for (const files of maps.slice(1)) {
      const existing = carriedByArm.get(arm) ?? new Map();
      for (const [name, hash] of files) existing.set(name, hash);
      carriedByArm.set(arm, existing);
    }
  }
  assertArmIsolation(originByArm, carriedByArm);
  for (const { chain, maps } of chainMaps) {
    if (maps[0].has(CARRYOVER_MARKER)) {
      fail(`${chain[0].arm} episode ${chain[0].episodeIndex} must not carry a previous-episode marker`);
    }
    for (let index = 1; index < chain.length; index += 1) {
      const trial = chain[index];
      if (!maps[index].has(CARRYOVER_MARKER)) {
        fail(
          `carryover staging was bypassed: missing ${CARRYOVER_MARKER}`,
          `${trial.arm} episode ${trial.episodeIndex} repetition ${trial.repetition}`,
        );
      }
      if (!mapsEqual(withoutMarker(maps[index]), withoutMarker(maps[index - 1]))) {
        fail(
          `carryover staging was bypassed: episode was not inherited from the previous app`,
          `${trial.arm} episode ${trial.episodeIndex} repetition ${trial.repetition}`,
        );
      }
    }
  }
  process.stdout.write(`campaign carryover ok: ${groups.size} arm chains, seed ${seed}\n`);
}

main().catch((error) => {
  process.stderr.write(`ASSERTION FAILED: ${error.message}\n`);
  process.exit(1);
});
