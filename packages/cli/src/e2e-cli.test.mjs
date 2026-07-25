import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const E2E = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function run(cwd, args) {
  return execFileSync(process.execPath, [E2E, ...args], {
    cwd,
    env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('e2e-fleet-'), 's') },
  }).toString();
}

/** .forge fixture with an active session tracking a specs change. */
function makeFixture(root) {
  const sessionDir = path.join(root, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'fixture', planType: 'specs', openspecChange: 'my-change' })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' })}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(root, 'specs', 'changes', 'my-change'), { recursive: true });
}

test('e2e harness: record → show → surfaced by init; config keys preserved', () => {
  const root = tmp('e2e-harness-');
  makeFixture(root);
  // Pre-existing config keys must survive the harness merge-write.
  fs.writeFileSync(
    path.join(root, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
    'utf8',
  );

  assert.match(run(root, ['harness']), /No harness recorded/);

  run(root, [
    'harness',
    '--set',
    'compose test stack: server + scratch mongo on isolated ports',
    '--start',
    'npm run e2e:stack',
    '--dir',
    'scripts/e2e',
  ]);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(cfg.plan.engine, 'specs');
  assert.equal(cfg.e2e.harness.start, 'npm run e2e:stack');
  assert.match(cfg.e2e.harness.description, /compose test stack/);

  assert.match(run(root, ['harness']), /REUSE it — do not build/);
  assert.match(run(root, ['init']), /REUSE it — do not build/);
  assert.equal(JSON.parse(run(root, ['status'])).harness.dir, 'scripts/e2e');
});

test('e2e harness --set requires a description', () => {
  const root = tmp('e2e-harness-req-');
  makeFixture(root);
  assert.throws(() => run(root, ['harness', '--set']), /Usage: forge e2e harness --set/);
});

test('e2e disable/enable toggles the project off switch; check honors it', () => {
  const root = tmp('e2e-disable-');
  makeFixture(root);

  assert.match(run(root, ['disable', 'slow legacy stack']), /E2E disabled/);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(cfg.e2e.disabled, 'slow legacy stack');

  // check passes without any e2e.json while disabled
  const check = JSON.parse(run(root, ['check']));
  assert.equal(check.ok, true);
  assert.equal(check.disabled, 'slow legacy stack');

  assert.throws(() => run(root, ['disable']), /reason is required/);

  run(root, ['enable']);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(cfg2.e2e.disabled, null);
  // gate demands e2e.json again once re-enabled → non-zero exit
  assert.throws(() => run(root, ['check']));
});

/** Like run(), but tolerates a non-zero exit (a failing loop exits 1). */
function runAllowFail(cwd, args) {
  try {
    return run(cwd, args);
  } catch (err) {
    return `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
  }
}

test('e2e run --repeat measures flakiness instead of trusting one green run', () => {
  // volo's smoke suite pinned --workers=1 in 6/6 changes to route around a
  // race nobody fixed, and the server suite's clean-tree baseline was "1-4
  // varying failures" — invisible to every verify phase.
  const root = tmp('forge-e2e-repeat-');
  makeFixture(root);
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  const counter = path.join(root, 'runs.txt');
  // Fails on the 2nd invocation only: a textbook flake.
  const cmd = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; test "$n" != "2"`;
  fs.writeFileSync(
    path.join(changeDir, 'e2e.json'),
    `${JSON.stringify({ steps: [{ name: 'flaky-step', cmd }] })}\n`,
    'utf8',
  );

  const out = runAllowFail(root, ['run', '--repeat', '3', '--record-baseline']);
  assert.match(out, /2\/3 runs green/);
  assert.match(out, /FLAKY\s+flaky-step — failed 1\/3 runs/);

  const config = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(config.e2e.baseline.runs, 3);
  assert.equal(config.e2e.baseline.green, 2);
  assert.equal(config.e2e.baseline.flakySteps[0].step, 'flaky-step');

  // A flaky loop must not be recorded as a green run.
  const results = JSON.parse(
    fs.readFileSync(path.join(root, '.forge', 'sessions', 's1', 'e2e-results.json'), 'utf8'),
  );
  assert.equal(results.ok, false);
});
