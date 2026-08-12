import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARRYOVER_MARKER } from './tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, 'corpora', 'forgekit-campaign-v1.json');
const runner = path.join(here, 'run.mjs');

const COVERED_PATHS = [
  '/app/package.json',
  '/app/src/server.mjs',
  '/app/data/orders.json',
  '/app/BLOCKED.md',
  `/app/${CARRYOVER_MARKER}`,
  '/app/.forge/session.json',
];

function parseArtifacts(source) {
  const match = source.match(/^artifacts\s*=\s*\[([\s\S]*?)^\]\s*$/m);
  assert.ok(match, 'task.toml must declare artifacts');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function normalizeArtifact(entry) {
  if (entry === '/') return '/';
  return entry.replace(/\/+$/, '') || '/';
}

/** Harbor 0.20: first overlapping claimant wins; later overlapping sources are skipped. */
function firstClaimantWins(paths) {
  const kept = [];
  for (const entry of paths) {
    const normalized = normalizeArtifact(entry);
    const overlaps = kept.some((existing) => {
      const other = normalizeArtifact(existing);
      return normalized === other
        || normalized.startsWith(`${other}/`)
        || other.startsWith(`${normalized}/`);
    });
    if (!overlaps) kept.push(entry);
  }
  return kept;
}

function covers(kept, target) {
  const needle = normalizeArtifact(target);
  return kept.some((entry) => {
    const root = normalizeArtifact(entry);
    return needle === root || needle.startsWith(`${root}/`);
  });
}

test('every campaign episode declares a single /app/ artifact so Harbor copies the full tree', async () => {
  const declared = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(declared.episodes.length, 6);
  for (const episode of declared.episodes) {
    const source = await readFile(
      path.join(here, 'tasks', 'forgekit-campaign-v1', episode.id, 'task.toml'),
      'utf8',
    );
    const artifacts = parseArtifacts(source);
    assert.deepEqual(
      artifacts,
      ['/app/'],
      `${episode.id} must not mix nested /app paths with /app/ (Harbor skips the parent)`,
    );
    const kept = firstClaimantWins(artifacts);
    for (const required of COVERED_PATHS) {
      assert.ok(covers(kept, required), `${episode.id} kept artifacts do not cover ${required}`);
    }
  }
});

test('Harbor overlap skips a parent /app when nested /app paths are listed first', () => {
  const kept = firstClaimantWins([
    '/app/package.json',
    '/app/src/',
    '/app/',
  ]);
  assert.deepEqual(kept, ['/app/package.json', '/app/src/']);
  assert.equal(covers(kept, '/app/.forge/session.json'), false);
  assert.equal(covers(kept, '/app/BLOCKED.md'), false);
});

test('campaign Harbor argv does not re-add overlapping /app artifacts', async (t) => {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'forgekit-campaign-artifacts-'));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const tarball = path.join(runsRoot, 'dummy.tgz');
  await writeFile(tarball, 'forgekit campaign artifacts test; never installed\n');
  const result = spawnSync(process.execPath, [
    runner,
    '--corpus', 'forgekit-campaign-v1',
    '--arm', 'both',
    '--repetitions', '1',
    '--concurrency', '1',
    '--seed', 'artifact-carry',
    '--agent', 'claude-code',
    '--model', 'claude-sonnet-5',
    '--forgekit-tarball', tarball,
    '--dry-run',
  ], {
    cwd: path.resolve(here, '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, FORGEKIT_EVAL_RUNS_ROOT: runsRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const runDirectory = path.join(runsRoot, plan.runId);
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  assert.equal(plan.trials.length, 12);

  const toml = await readFile(
    path.join(here, 'tasks', 'forgekit-campaign-v1', 'episode-01', 'task.toml'),
    'utf8',
  );
  const taskArtifacts = parseArtifacts(toml);

  for (const trial of plan.trials) {
    const cliArtifacts = trial.harborArgv.flatMap((value, index) => (
      value === '--artifact' ? [trial.harborArgv[index + 1]] : []
    ));
    const kept = firstClaimantWins([...taskArtifacts, ...cliArtifacts]);
    assert.ok(
      covers(kept, '/app/.forge/session.json'),
      `${trial.trialId} Harbor collection must keep a claimant that covers /app/.forge`,
    );
    assert.ok(
      covers(kept, `/app/${CARRYOVER_MARKER}`),
      `${trial.trialId} Harbor collection must keep a claimant that covers the carryover marker`,
    );
    assert.ok(
      covers(kept, '/app/BLOCKED.md'),
      `${trial.trialId} Harbor collection must keep a claimant that covers BLOCKED.md`,
    );
  }
});
