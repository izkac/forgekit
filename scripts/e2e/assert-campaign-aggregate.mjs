#!/usr/bin/env node
/**
 * Product-loop check for campaign aggregation: per-episode paired deltas
 * derived from fixture cells, complete/incomplete pair counts, and a
 * carryover failure listed incomplete rather than credited as a zero.
 *
 * Spawns the shipped aggregator (`evals/harbor/aggregate-results.mjs`).
 * A `silent-credit/` sibling that writes a verified zero for the failed
 * arm must be rejected; the default fixtures directory still exits 0
 * because it accepts the honest report and confirms that rejection.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGGREGATE = path.join(REPO, 'evals/harbor/aggregate-results.mjs');
const ARMS = ['baseline', 'forge'];
const OUTCOMES = ['functional', 'regression', 'tests_unchanged', 'shippable'];

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let fixtures = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--fixtures') fail(`unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('--fixtures requires a value');
    fixtures = value;
    index += 1;
  }
  if (fixtures === null) fail('--fixtures is required');
  return { fixtures: path.resolve(fixtures) };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read JSON: ${file}`, error.message);
  }
}

function findRunDirs(root) {
  const found = [];
  function visit(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') fail(`fixtures directory does not exist: ${current}`);
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'plan.json')) {
      found.push(current);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(current, entry.name));
    }
  }
  visit(root);
  return found.sort();
}

function isSilentCreditPath(filePath, fixturesRoot) {
  const relative = path.relative(fixturesRoot, filePath);
  const parts = relative.split(path.sep);
  return path.basename(fixturesRoot) === 'silent-credit' || parts[0] === 'silent-credit';
}

function silentCreditSibling(fixturesDir) {
  const child = path.join(fixturesDir, 'silent-credit');
  if (existsSync(child) && statSync(child).isDirectory()) return child;
  if (path.basename(fixturesDir) === 'silent-credit') return fixturesDir;
  const sibling = path.join(path.dirname(fixturesDir), 'silent-credit');
  if (existsSync(sibling) && statSync(sibling).isDirectory()) return sibling;
  return null;
}

function loadCarryoverFailure(runDir) {
  const file = path.join(runDir, 'carryover-failure.json');
  if (!existsSync(file)) return null;
  const marker = readJson(file);
  if (!Number.isSafeInteger(marker.episode_index) || !ARMS.includes(marker.arm)) {
    fail(`carryover-failure.json is malformed: ${file}`);
  }
  return marker;
}

function loadCells(runDir) {
  const plan = readJson(path.join(runDir, 'plan.json'));
  if (!Array.isArray(plan.trials) || plan.trials.length === 0) fail(`plan.trials is empty: ${runDir}`);
  const cells = [];
  for (const trial of plan.trials) {
    const manifest = readJson(path.join(runDir, trial.manifest));
    let shippable = null;
    if (manifest.status === 'verified') {
      const normalized = readJson(path.join(runDir, manifest.normalizedResult));
      shippable = normalized.outcome?.shippable;
    }
    cells.push({
      arm: trial.arm,
      episodeIndex: trial.episodeIndex,
      status: manifest.status,
      shippable,
    });
  }
  return { plan, cells, marker: loadCarryoverFailure(runDir) };
}

function allZeroOutcome(runDir, trial) {
  if (trial.status !== 'verified') return false;
  const manifest = readJson(path.join(runDir, trial.manifest));
  if (manifest.status !== 'verified') return false;
  const normalized = readJson(path.join(runDir, manifest.normalizedResult));
  return OUTCOMES.every((name) => normalized.outcome?.[name] === 0);
}

function isSilentlyCredited(runDir, plan, marker) {
  if (marker === null) return false;
  const trial = plan.trials.find((candidate) => (
    candidate.episodeIndex === marker.episode_index && candidate.arm === marker.arm
  ));
  if (trial === undefined) return false;
  return allZeroOutcome(runDir, trial);
}

function spawnAggregate(runDirs) {
  const argv = runDirs.flatMap((directory) => ['--run-directory', directory]);
  const result = spawnSync(process.execPath, [AGGREGATE, ...argv], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(
      'shipped aggregator exited nonzero',
      result.stderr || result.stdout || `exit ${result.status}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('shipped aggregator did not emit JSON', result.stdout);
  }
}

function cellFor(cells, episodeIndex, arm) {
  return cells.find((cell) => cell.episodeIndex === episodeIndex && cell.arm === arm);
}

function expectedFromCells(cells) {
  const indexes = [...new Set(cells.map((cell) => cell.episodeIndex))].sort((left, right) => left - right);
  const complete = [];
  const incomplete = [];
  for (const episodeIndex of indexes) {
    const baseline = cellFor(cells, episodeIndex, 'baseline');
    const forge = cellFor(cells, episodeIndex, 'forge');
    const bothVerified = baseline?.status === 'verified' && forge?.status === 'verified'
      && baseline.shippable !== null && forge.shippable !== null;
    if (bothVerified) complete.push({ episodeIndex, delta: forge.shippable - baseline.shippable });
    else incomplete.push(episodeIndex);
  }
  return { complete, incomplete };
}

function assertHonestReport(report, cells, marker) {
  const expected = expectedFromCells(cells);
  if (report.pairs.complete !== expected.complete.length) {
    fail(
      'complete pair count does not match fixture cells',
      `expected ${expected.complete.length}, got ${report.pairs.complete}`,
    );
  }
  if (report.pairs.incomplete !== expected.incomplete.length) {
    fail(
      'incomplete pair count does not match fixture cells',
      `expected ${expected.incomplete.length}, got ${report.pairs.incomplete}`,
    );
  }
  for (const { episodeIndex, delta } of expected.complete) {
    const entry = report.episodes?.[episodeIndex];
    if (entry === undefined) fail(`aggregator omitted episode ${episodeIndex}`);
    if (entry.pairs.complete !== 1 || entry.pairs.incomplete !== 0) {
      fail(`episode ${episodeIndex} pair counts are wrong`, JSON.stringify(entry.pairs));
    }
    if (entry.pairs.outcomes.shippable.mean_delta !== delta) {
      fail(
        `episode ${episodeIndex} paired delta does not match fixture cells`,
        `expected ${delta}, got ${entry.pairs.outcomes.shippable.mean_delta}`,
      );
    }
  }
  if (marker === null) fail('honest fixture is missing carryover-failure.json');
  const entry = report.episodes?.[marker.episode_index];
  if (entry === undefined) fail(`aggregator omitted carryover-failure episode ${marker.episode_index}`);
  if (entry.pairs.complete !== 0 || entry.pairs.incomplete !== 1) {
    fail(
      'carryover failure was not reported as an incomplete pair',
      JSON.stringify(entry.pairs),
    );
  }
  if (entry.pairs.outcomes.shippable.mean_delta !== null) {
    fail(
      'carryover failure was credited as a numeric delta instead of incomplete',
      `mean_delta=${entry.pairs.outcomes.shippable.mean_delta}`,
    );
  }
  const listed = (report.pairs.incomplete_pairs ?? []).some((pair) => (
    pair.episode_index === marker.episode_index && pair.missing_arms?.includes(marker.arm)
  ));
  if (!listed) {
    fail(
      'carryover failure is missing from incomplete_pairs',
      JSON.stringify(report.pairs.incomplete_pairs),
    );
  }
  if (entry.arms[marker.arm].outcomes.shippable.observations !== 0) {
    fail(
      'carryover failure was treated as a zero outcome',
      JSON.stringify(entry.arms[marker.arm].outcomes.shippable),
    );
  }
}

function assertHonestRuns(runDirs) {
  if (runDirs.length === 0) fail('no honest campaign runs found under --fixtures');
  const loaded = runDirs.map((dir) => ({ dir, ...loadCells(dir) }));
  for (const item of loaded) {
    if (isSilentlyCredited(item.dir, item.plan, item.marker)) {
      fail(
        'silently credited a verified zero for a carryover failure',
        `${item.dir} episode ${item.marker.episode_index} arm ${item.marker.arm}`,
      );
    }
  }
  const report = spawnAggregate(runDirs);
  const cells = loaded.flatMap((item) => item.cells);
  const marker = loaded.map((item) => item.marker).find(Boolean) ?? null;
  assertHonestReport(report, cells, marker);
}

function rejectSilentCredit(silentRoot) {
  const runDirs = findRunDirs(silentRoot);
  if (runDirs.length === 0) fail(`silent-credit fixture has no runs: ${silentRoot}`);
  let detected = false;
  for (const dir of runDirs) {
    const { plan, marker } = loadCells(dir);
    if (isSilentlyCredited(dir, plan, marker)) detected = true;
  }
  if (!detected) fail(`silent-credit fixture did not write a verified zero for the failed arm: ${silentRoot}`);
  const report = spawnAggregate(runDirs);
  const credited = runDirs.some((dir) => {
    const marker = loadCarryoverFailure(dir);
    if (marker === null) return false;
    const entry = report.episodes?.[marker.episode_index];
    return entry?.pairs.complete === 1 && entry.pairs.outcomes.shippable.mean_delta !== null;
  });
  if (!credited) {
    fail('silent-credit fixture did not produce a credited pair from the aggregator');
  }
}

function main() {
  const { fixtures } = parseArgs(process.argv.slice(2));
  const primaryIsSilent = path.basename(fixtures) === 'silent-credit';
  if (primaryIsSilent) {
    const runDirs = findRunDirs(fixtures);
    assertHonestRuns(runDirs);
    fail('silent-credit fixture was accepted');
  }

  const allRuns = findRunDirs(fixtures);
  const honestRuns = allRuns.filter((dir) => !isSilentCreditPath(dir, fixtures));
  assertHonestRuns(honestRuns);

  const silentRoot = silentCreditSibling(fixtures);
  if (silentRoot === null) fail('silent-credit fixture is missing next to --fixtures');
  rejectSilentCredit(silentRoot);
  process.stdout.write(
    `campaign aggregate ok: ${honestRuns.length} honest run(s), silent-credit rejected\n`,
  );
}

main();
