#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCampaign, selectCorpus } from './corpus-selection.mjs';
import { CARRYOVER_MARKER } from './tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const corpusId = 'forgekit-campaign-v1';
const manifestPath = path.join(here, 'corpora', `${corpusId}.json`);
const runner = process.env.FORGEKIT_SMOKE_RUNNER || path.join(here, 'run.mjs');
const hostSuites = [
  {
    label: 'episodes 1-3',
    file: path.join(here, 'corpus-campaign-v1-episodes-1-3.test.mjs'),
    coverageNote: 'untouched, oracle, alternate (episode 3 alternate is the BLOCKED.md oracle)',
  },
  {
    label: 'episodes 4-6',
    file: path.join(here, 'corpus-campaign-v1-episodes-4-6.test.mjs'),
    coverageNote: 'untouched, oracle, alternate, episode 6 naive-expiry negative',
  },
];
const hostSuiteCoverage = [
  'untouched-negative',
  'oracle-positive',
  'alternate-positive',
  'tamper-negative',
];
const hiddenVerifierBasenames = ['grader.mjs', 'test.sh', 'hidden-probe.mjs'];
const fakeTarballBytes = Buffer.from('forgekit campaign smoke only; never installed\n');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr, error: null }));
  });
}

async function requireFiles(root, relatives) {
  for (const relative of relatives) {
    const target = path.join(root, relative);
    let info;
    try {
      info = await stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`campaign episode is missing required file: ${relative}`);
      throw error;
    }
    requireCondition(info.isFile(), `campaign required path is not a file: ${relative}`);
  }
}

function tomlSection(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
  requireCondition(match, `task.toml is missing [${name}]`);
  return match[1];
}

function quotedValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  requireCondition(match, `task.toml is missing ${key}`);
  return match[1];
}

function numericValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm'));
  requireCondition(match, `task.toml is missing numeric ${key}`);
  return Number(match[1]);
}

function extraRequiredFiles(entry) {
  const files = [];
  if (entry.index === 1) {
    files.push(
      'environment/app/src/server.mjs',
      'environment/app/src/app.mjs',
      'environment/app/src/orders.test.mjs',
      'fixtures/alternate-positive/solve.sh',
    );
  }
  if (entry.index === 2) {
    files.push('fixtures/alternate-positive/solve.sh', 'fixtures/break-cancelled-money/solve.sh');
  }
  if (entry.index === 3) files.push('fixtures/silent-cancelled-refunds/solve.sh');
  if (entry.index === 4) files.push('fixtures/break-one-endpoint/solve.sh');
  if (entry.index === 5) files.push('fixtures/drop-edge-case/solve.sh');
  if (entry.index === 6) files.push('fixtures/naive-expiry/solve.sh');
  if (entry.index > 1) files.push('tests/carryover-precondition.mjs');
  return files;
}

async function loadAndValidateManifest() {
  const selection = selectCorpus(corpusId);
  const campaign = await parseCampaign(selection);
  requireCondition(campaign.episodes !== null, 'campaign manifest must declare episodes');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  requireCondition(manifest.schema_version === 1, 'campaign manifest schema_version must be 1');
  requireCondition(manifest.corpus_id === corpusId, `campaign manifest corpus_id must be ${corpusId}`);
  requireCondition(Array.isArray(manifest.episodes) && manifest.episodes.length > 0, 'campaign manifest must select at least one episode');
  requireCondition(manifest.episodes.length === campaign.episodes.length, 'campaign parse and manifest episode counts differ');
  const ids = new Set();
  for (const [offset, entry] of manifest.episodes.entries()) {
    requireCondition(entry && typeof entry === 'object' && !Array.isArray(entry), 'campaign episode must be an object');
    requireCondition(/^episode-\d{2}$/.test(entry.id), `campaign episode id must be episode-NN: ${entry.id}`);
    requireCondition(!ids.has(entry.id), `campaign episode is duplicated: ${entry.id}`);
    ids.add(entry.id);
    requireCondition(entry.index === offset + 1, `campaign episode index must be contiguous and one-based: ${entry.id}`);
    requireCondition(/^\d+\.\d+\.\d+$/.test(entry.version), `campaign episode version must be semantic: ${entry.id}`);
    requireCondition(entry.task_path === `tasks/${corpusId}/${entry.id}`, `campaign task_path is not bound to its episode: ${entry.id}`);
  }
  return { manifest, campaign };
}

async function validateEpisodeMetadata(entry, taskRoot) {
  const source = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  requireCondition(/^schema_version\s*=\s*"1\.4"\s*$/m.test(source), 'campaign episode must declare Harbor schema 1.4');
  await requireFiles(taskRoot, [
    'task.toml',
    'instruction.md',
    'environment/Dockerfile',
    'environment/app/package.json',
    'tests/Dockerfile',
    'tests/grader.mjs',
    'tests/test.sh',
    'tests/hidden-probe.mjs',
    'solution/solve.sh',
    ...extraRequiredFiles(entry),
  ]);
  const task = tomlSection(source, 'task');
  requireCondition(quotedValue(task, 'name') === `forgekit/${entry.id}`, 'campaign task.toml name does not match episode');
  requireCondition(quotedValue(task, 'version') === entry.version, 'campaign manifest and task.toml versions differ');
  requireCondition(quotedValue(task, 'description').length > 0, 'campaign episode description must not be empty');
  const metadata = tomlSection(source, 'metadata');
  requireCondition(quotedValue(metadata, 'difficulty').length > 0, 'campaign episode difficulty must not be empty');
  requireCondition(quotedValue(metadata, 'benchmark_category').length > 0, 'campaign episode benchmark_category must not be empty');
  requireCondition(numericValue(tomlSection(source, 'agent'), 'timeout_sec') > 0, 'campaign agent timeout must be positive');
  const verifier = tomlSection(source, 'verifier');
  requireCondition(numericValue(verifier, 'timeout_sec') > 0, 'campaign verifier timeout must be positive');
  requireCondition(quotedValue(verifier, 'environment_mode') === 'separate', 'campaign verifier must use a separate environment');
  requireCondition(quotedValue(tomlSection(source, 'verifier.environment'), 'network_mode') === 'no-network', 'campaign verifier network must be disabled');
  requireCondition(quotedValue(tomlSection(source, 'environment'), 'network_mode') === 'public', 'campaign agent environment must permit setup egress');

  const verifierDockerfile = await readFile(path.join(taskRoot, 'tests', 'Dockerfile'), 'utf8');
  requireCondition(/HARBOR_UNTRUSTED_UID=65534/.test(verifierDockerfile), 'campaign verifier must drop privileges for agent-controlled code');
  requireCondition(/chmod -R 700 \/tests/.test(verifierDockerfile), 'campaign verifier sources must remain root-only');
  const environmentFiles = await directoryMap(path.join(taskRoot, 'environment'));
  requireCondition(
    ![...environmentFiles.keys()].some((name) => hiddenVerifierBasenames.includes(path.posix.basename(name))),
    'campaign hidden verifier sources leaked into the agent environment',
  );
  return {
    category: quotedValue(metadata, 'benchmark_category'),
    difficulty: quotedValue(metadata, 'difficulty'),
  };
}

async function directoryMap(directory) {
  const files = new Map();
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        files.set(childRelative, createHash('sha256').update(await readFile(child)).digest('hex'));
      } else throw new Error(`unsupported campaign episode entry: ${childRelative}`);
    }
  }
  await visit(directory);
  return files;
}

function changedFiles(canonical, staged) {
  const names = new Set([...canonical.keys(), ...staged.keys()]);
  return [...names].filter((name) => canonical.get(name) !== staged.get(name)).sort();
}

function stagedPathFor(plan, runDirectory, episodeId, arm) {
  const trial = plan.trials.find((candidate) => (
    candidate.episodeId === episodeId && candidate.arm === arm && candidate.repetition === 1
  ));
  requireCondition(trial, `campaign plan is missing a ${arm} trial for ${episodeId}`);
  const relative = trial.harborArgv[trial.harborArgv.indexOf('--path') + 1];
  requireCondition(typeof relative === 'string' && relative.length > 0, `campaign trial is missing a staged path: ${episodeId}`);
  return path.join(runDirectory, relative);
}

function environmentHasHiddenVerifier(environmentMap) {
  return [...environmentMap.keys()].some((name) => (
    name === 'tests'
    || name.startsWith('tests/')
    || hiddenVerifierBasenames.includes(path.posix.basename(name))
  ));
}

async function stageCampaign(workDirectory, fakeTarball) {
  const result = await run(process.execPath, [
    runner,
    '--corpus', corpusId,
    '--arm', 'both',
    '--repetitions', '1',
    '--concurrency', '1',
    '--seed', 'smoke-campaign',
    '--agent', 'smoke-local',
    '--model', 'local/not-executed',
    '--forgekit-tarball', fakeTarball,
    '--dry-run',
  ], { env: { FORGEKIT_EVAL_RUNS_ROOT: path.join(workDirectory, 'runs') } });
  if (result.code !== 0) throw new Error(`campaign runner dry-run failed: ${result.stderr.trim() || result.stdout.trim()}`);
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    throw new Error('campaign runner dry-run did not emit a JSON plan');
  }
  requireCondition(plan.dryRun === true, 'campaign staging must be a dry run');
  requireCondition(plan.corpus?.id === corpusId, 'runner did not select the campaign corpus');
  requireCondition(plan.campaign?.id === corpusId, 'runner plan is missing campaign identity');
  requireCondition(plan.settings?.arm === 'both', 'runner did not stage both campaign arms');
  requireCondition(plan.settings?.forgekitTreatment?.kind === 'local-tarball', 'campaign Forge arm did not use the harmless local tarball');
  requireCondition(plan.trials?.every((trial) => trial.status === 'dry-run'), 'runner attempted a non-dry campaign trial');
  const runDirectory = path.join(workDirectory, 'runs', plan.runId);
  return { plan, runDirectory };
}

async function validateArmTreatment(entry, stagedRoot, arm, stagedFilename) {
  const [dockerfile, instruction] = await Promise.all([
    readFile(path.join(stagedRoot, 'environment', 'Dockerfile'), 'utf8'),
    readFile(path.join(stagedRoot, 'instruction.md'), 'utf8'),
  ]);
  if (arm === 'baseline') {
    requireCondition(!dockerfile.includes('forgekit-treatment'), `${entry.id} baseline arm installs Forgekit`);
    requireCondition(/Evaluation arm: baseline/.test(instruction) && !/Forge workflow/i.test(instruction), `${entry.id} baseline instruction contains Forge treatment`);
    return;
  }
  requireCondition(dockerfile.includes(`COPY ${stagedFilename} /tmp/forgekit-treatment.tgz`), `${entry.id} Forge arm is missing its staged local treatment`);
  requireCondition(!dockerfile.includes('@izkac/forgekit@'), `${entry.id} Forge smoke would install a registry package`);
  requireCondition(/Evaluation arm: forge/.test(instruction) && /Forge workflow/.test(instruction), `${entry.id} Forge instruction is missing its treatment`);
  requireCondition(
    (await readFile(path.join(stagedRoot, 'environment', stagedFilename))).equals(fakeTarballBytes),
    `${entry.id} Forge staging changed the harmless local tarball`,
  );
}

async function validateEpisodeStaging(entry, taskRoot, plan, runDirectory) {
  const stagedByArm = {
    baseline: stagedPathFor(plan, runDirectory, entry.id, 'baseline'),
    forge: stagedPathFor(plan, runDirectory, entry.id, 'forge'),
  };
  const stagedFilename = plan.settings.forgekitTreatment.stagedFilename;
  const canonicalMap = await directoryMap(taskRoot);
  const canonicalTests = await directoryMap(path.join(taskRoot, 'tests'));
  for (const arm of ['baseline', 'forge']) {
    const stagedRoot = stagedByArm[arm];
    const stagedMap = await directoryMap(stagedRoot);
    const stagedTests = await directoryMap(path.join(stagedRoot, 'tests'));
    requireCondition(JSON.stringify([...stagedTests]) === JSON.stringify([...canonicalTests]), `${arm} ${entry.id} staging changed hidden verifier files`);
    const environmentMap = await directoryMap(path.join(stagedRoot, 'environment'));
    requireCondition(!environmentHasHiddenVerifier(environmentMap), `${arm} ${entry.id} agent environment contains hidden verifier code`);
    await validateArmTreatment(entry, stagedRoot, arm, stagedFilename);
    const stagedApp = path.join(stagedRoot, 'environment', 'app');
    const marker = path.join(stagedApp, CARRYOVER_MARKER);
    if (entry.index === 1) {
      const expected = arm === 'baseline'
        ? ['instruction.md']
        : ['environment/Dockerfile', `environment/${stagedFilename}`, 'instruction.md'].sort();
      requireCondition(
        JSON.stringify(changedFiles(canonicalMap, stagedMap)) === JSON.stringify(expected),
        `${arm} ${entry.id} staging changed files outside its arm treatment`,
      );
      await stat(marker).then(
        () => { throw new Error(`${arm} ${entry.id} must not carry a previous-episode marker`); },
        (error) => { if (error.code !== 'ENOENT') throw error; },
      );
    } else {
      await stat(marker);
      await stat(path.join(stagedApp, 'src', 'orders.test.mjs'));
    }
  }
  return stagedByArm;
}

async function gradeApp(episodeRoot, workDirectory, app) {
  const rewardFile = path.join(workDirectory, 'reward.json');
  const result = await run(process.execPath, [path.join(episodeRoot, 'tests', 'grader.mjs')], {
    env: {
      HARBOR_APP_DIR: app,
      HARBOR_REWARD_DIR: workDirectory,
      HARBOR_REWARD_FILE: rewardFile,
    },
  });
  if (result.code !== 0) throw new Error(`campaign tamper grader failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return JSON.parse(await readFile(rewardFile, 'utf8'));
}

async function validateTamperNegative(episodeRoot) {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-campaign-tamper-'));
  try {
    const app = path.join(workDirectory, 'app');
    await cp(path.join(episodeRoot, 'environment', 'app'), app, { recursive: true });
    const clean = await gradeApp(episodeRoot, workDirectory, app);
    requireCondition(clean.tests_unchanged === 1, 'campaign protected files should match before tamper');
    const visibleTest = path.join(app, 'src', 'orders.test.mjs');
    await writeFile(visibleTest, `${await readFile(visibleTest, 'utf8')}\n// tampered\n`);
    const tampered = await gradeApp(episodeRoot, workDirectory, app);
    requireCondition(tampered.tests_unchanged === 0, 'mutating the protected visible test must fail tests_unchanged');
    requireCondition(tampered.shippable === 0, 'tampered visible test must not be shippable');
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function runHostSuites() {
  for (const suite of hostSuites) {
    const result = await run(process.execPath, ['--test', suite.file]);
    if (result.code !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
      throw new Error(`campaign host suite failed for ${suite.label}: ${detail}`);
    }
    process.stdout.write(`PASS campaign host suite: ${suite.label} (${suite.coverageNote})\n`);
  }
  return { status: 'passed', coverage: hostSuiteCoverage };
}

async function validateBuildContext(label, dockerfile, context) {
  const source = await readFile(dockerfile, 'utf8');
  requireCondition(/^FROM\s+\S+/m.test(source), `${label} Dockerfile has no FROM instruction`);
  const copyLines = source.split('\n').map((line) => line.trim()).filter((line) => /^COPY\s+/i.test(line));
  requireCondition(copyLines.length > 0, `${label} Dockerfile has no COPY instruction`);
  for (const line of copyLines) {
    const fields = line.split(/\s+/).slice(1).filter((field) => !field.startsWith('--'));
    requireCondition(fields.length >= 2, `${label} has an invalid COPY instruction`);
    for (const sourcePath of fields.slice(0, -1)) {
      requireCondition(!path.isAbsolute(sourcePath) && !sourcePath.split(/[\\/]/).includes('..'), `${label} COPY escapes its build context`);
      try {
        await stat(path.join(context, sourcePath));
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${label} COPY source does not exist: ${sourcePath}`);
        throw error;
      }
    }
  }
}

function dockerContexts(entry, stagedByArm) {
  return [
    {
      label: `${entry.id}:baseline-agent`,
      context: path.join(stagedByArm.baseline, 'environment'),
      dockerfile: path.join(stagedByArm.baseline, 'environment', 'Dockerfile'),
    },
    {
      label: `${entry.id}:forge-agent`,
      context: path.join(stagedByArm.forge, 'environment'),
      dockerfile: path.join(stagedByArm.forge, 'environment', 'Dockerfile'),
    },
    {
      label: `${entry.id}:separate-verifier`,
      context: path.join(stagedByArm.baseline, 'tests'),
      dockerfile: path.join(stagedByArm.baseline, 'tests', 'Dockerfile'),
    },
  ];
}

async function validateDocker(contexts) {
  for (const item of contexts) await validateBuildContext(item.label, item.dockerfile, item.context);
  const probe = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (probe.error || probe.code !== 0) {
    const detail = probe.error?.code === 'ENOENT' ? 'Docker CLI is unavailable' : 'Docker daemon is unavailable';
    process.stdout.write(`SKIP Docker validation: ${detail}\n`);
    return { status: 'skipped', reason: detail, contexts: contexts.map(({ label }) => label) };
  }
  for (const item of contexts) {
    const checked = await run('docker', ['build', '--check', '--file', item.dockerfile, item.context]);
    if (checked.code !== 0) {
      throw new Error(`Docker validation failed for ${item.label}: ${checked.stderr.trim() || checked.stdout.trim() || checked.error?.message || `exit ${checked.code}`}`);
    }
  }
  process.stdout.write(`PASS Docker validation: ${contexts.length} campaign build contexts\n`);
  return { status: 'validated', method: 'docker build --check', contexts: contexts.map(({ label }) => label) };
}

async function main() {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgekit-harbor-campaign-smoke-'));
  let runDirectory;
  try {
    const fakeTarball = path.join(workDirectory, 'forgekit-smoke-treatment.tgz');
    await writeFile(fakeTarball, fakeTarballBytes);
    const { manifest } = await loadAndValidateManifest();
    const episodes = {};
    const contexts = [];
    const episodeRoots = new Map();
    for (const entry of manifest.episodes) {
      const taskRoot = path.join(here, entry.task_path);
      episodeRoots.set(entry.id, taskRoot);
      const metadata = await validateEpisodeMetadata(entry, taskRoot);
      process.stdout.write(`PASS campaign manifest and episode metadata: ${entry.id}\n`);
      episodes[entry.id] = { index: entry.index, category: metadata.category, difficulty: metadata.difficulty };
    }
    const staged = await stageCampaign(workDirectory, fakeTarball);
    runDirectory = staged.runDirectory;
    requireCondition(
      staged.plan.campaign.episodes.length === manifest.episodes.length,
      'campaign dry-run episode count differs from the manifest',
    );
    requireCondition(
      staged.plan.trials.length === manifest.episodes.length * 2,
      'campaign dry-run must stage one trial per episode per arm',
    );
    for (const entry of manifest.episodes) {
      const stagedByArm = await validateEpisodeStaging(entry, episodeRoots.get(entry.id), staged.plan, staged.runDirectory);
      process.stdout.write(`PASS campaign baseline/Forge staging and verifier isolation: ${entry.id}\n`);
      contexts.push(...dockerContexts(entry, stagedByArm));
    }
    await validateTamperNegative(episodeRoots.get(manifest.episodes[0].id));
    process.stdout.write('PASS campaign tamper-negative: mutating protected visible test (planting verifier files in /app is caught by isolation)\n');
    const hostSuite = await runHostSuites();
    for (const entry of manifest.episodes) episodes[entry.id].hostSuite = hostSuite;
    const docker = await validateDocker(contexts);
    const modelHarbor = { status: 'skipped', modelExecuted: false, reason: 'campaign local smoke never invokes Harbor or a model' };
    process.stdout.write('SKIP model/Harbor execution: campaign local smoke validation only; no model was invoked\n');
    process.stdout.write(`episodes validated: ${manifest.episodes.length}\n`);
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify({
      schemaVersion: 2,
      corpusId: manifest.corpus_id,
      arms: ['baseline', 'forge'],
      episodes,
      docker,
      modelHarbor,
    })}\n`);
  } finally {
    await Promise.all([
      rm(workDirectory, { recursive: true, force: true }),
      runDirectory ? rm(runDirectory, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`smoke-campaign.mjs: ${error.message}\n`);
  process.exitCode = 1;
});
