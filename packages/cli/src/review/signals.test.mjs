import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPathsToWorkspaces, suggestSignalCommands } from './lib.mjs';
import { parseArgs, runSignals } from './signals.mjs';

const PACKAGES = [
  { name: '@janus/persona', dir: 'services/persona', scripts: { typecheck: 'tsc', test: 'vitest' } },
  { name: '@janus/mercury', dir: 'services/mercury', scripts: { test: 'vitest' } },
  { name: '@janus/persona-contract', dir: 'packages/persona-contract', scripts: { build: 'tsc' } },
];

test('mapPathsToWorkspaces matches the deepest owning workspace', () => {
  const { workspaces, unmatched } = mapPathsToWorkspaces(
    [
      'services/persona/src/routes/profile.ts',
      'services/mercury/src/index.ts',
      'docs/thorough-code-review.md',
    ],
    PACKAGES,
  );
  assert.deepEqual(
    workspaces.map((w) => w.name),
    ['@janus/mercury', '@janus/persona'],
  );
  assert.deepEqual(unmatched, ['docs/thorough-code-review.md']);
});

test('mapPathsToWorkspaces normalizes backslashes and dedupes', () => {
  const { workspaces } = mapPathsToWorkspaces(
    ['services\\persona\\a.ts', 'services\\persona\\b.ts'],
    PACKAGES,
  );
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].name, '@janus/persona');
});

test('suggestSignalCommands emits only scripts that exist, in run order', () => {
  const commands = suggestSignalCommands([
    { name: '@janus/persona', scripts: { typecheck: 'tsc', test: 'vitest' } },
    { name: '@janus/mercury', scripts: { test: 'vitest' } },
  ]);
  assert.deepEqual(commands, [
    'npm run typecheck -w @janus/persona',
    'npm run test -w @janus/persona',
    'npm run test -w @janus/mercury',
  ]);
});

test('runSignals plans commands and flags contract touches', () => {
  const opts = parseArgs(['--paths', 'services/persona/src/routes/profile.ts', '--json']);
  const result = runSignals(opts, process.cwd(), PACKAGES);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.plan.workspaces, ['@janus/persona']);
  assert.ok(result.plan.commands.includes('npm run typecheck -w @janus/persona'));
  assert.ok(result.plan.notes.some((n) => n.includes('route-parity')));
});

test('runSignals reports paths outside any workspace', () => {
  const opts = parseArgs(['--paths', 'scripts/review/lib.mjs']);
  const result = runSignals(opts, process.cwd(), PACKAGES);
  assert.ok(result.plan.notes.some((n) => n.includes('outside any workspace')));
});
