import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const E2E = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e.mjs');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

test('e2e harness records setup + probe and surfaces them to the next session', () => {
  // A harness that records only "how to boot the app" is not portable: the
  // agent installs a browser in its sandbox, the probe goes green, and the
  // operator's fresh checkout fails on a runtime nobody wrote down.
  const root = tmp('e2e-harness-portable-');
  makeFixture(root);

  run(root, [
    'harness',
    '--set',
    'vite preview + playwright smoke',
    '--start',
    'npm run build && npm run preview',
    '--setup',
    'npx playwright install chromium',
    '--probe',
    'npm run test:e2e',
    '--dir',
    'e2e',
  ]);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(cfg.e2e.harness.setup, 'npx playwright install chromium');
  assert.equal(cfg.e2e.harness.probe, 'npm run test:e2e');
  assert.equal(cfg.e2e.harness.start, 'npm run build && npm run preview');

  // Printed in execution order: install it, start it, prove it, find it.
  const shown = run(root, ['harness']);
  assert.match(shown, /Setup:\s+npx playwright install chromium/);
  assert.match(shown, /Probe:\s+npm run test:e2e/);
  assert.ok(
    shown.indexOf('Setup:') < shown.indexOf('Start:') &&
      shown.indexOf('Start:') < shown.indexOf('Probe:') &&
      shown.indexOf('Probe:') < shown.indexOf('Location:'),
    `harness lines out of order:\n${shown}`,
  );

  assert.match(run(root, ['init']), /Setup:\s+npx playwright install chromium/);
  const status = JSON.parse(run(root, ['status']));
  assert.equal(status.harness.setup, 'npx playwright install chromium');
  assert.equal(status.harness.probe, 'npm run test:e2e');
});

test('/forge:harness templates stay in sync and teach setup + probe', () => {
  // The two editor templates are the same instruction shipped twice; they drift
  // silently because nothing reads both. Verified by hand once — now mechanically.
  const bodies = ['claude', 'cursor'].map((agent) => {
    const file = path.join(REPO_ROOT, 'templates', 'project', agent, 'commands', 'forge-harness.md');
    const text = fs.readFileSync(file, 'utf8');
    // Drop the frontmatter only — `.pop()` here would silently shrink the
    // compared region to whatever follows the last markdown rule in the body.
    const [, ...body] = text.split('\n---\n');
    return body.join('\n---\n').replace(/~\/\.(claude|cursor)\//g, '~/.AGENT/');
  });
  assert.equal(bodies[0], bodies[1], 'claude and cursor harness templates have drifted');

  for (const body of bodies) {
    assert.match(body, /--setup/, 'template must teach --setup');
    assert.match(body, /--probe/, 'template must teach --probe');
    // The rule has to generalize — a Playwright-only note is the thing this change rejects.
    assert.match(body, /browsers, drivers, container images, toolchains/);
  }
});

test('e2e harness warns when a flag is given without a value', () => {
  // Recording a harness that quietly lost its --setup is the exact failure the
  // field exists to prevent, so a valueless flag must not pass in silence.
  const root = tmp('e2e-harness-noval-');
  makeFixture(root);
  run(root, ['harness', '--set', 'rig', '--start', 'make serve', '--setup']);
  // The valueless flag is dropped, but the flags around it still land.
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'config.json'), 'utf8'));
  assert.equal(cfg.e2e.harness.setup, undefined);
  assert.equal(cfg.e2e.harness.start, 'make serve');

  const withStderr = spawnSync(
    process.execPath,
    [E2E, 'harness', '--set', 'rig', '--setup'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, FORGEKIT_FLEET_DIR: path.join(tmp('e2e-fleet-'), 's') } },
  );
  assert.match(withStderr.stderr, /Warning: --setup needs a value/);
  assert.equal(withStderr.status, 0, 'a valueless optional flag warns, it does not fail the command');
});

test('e2e harness without setup/probe prints no empty rows', () => {
  const root = tmp('e2e-harness-legacy-');
  makeFixture(root);
  run(root, ['harness', '--set', 'legacy rig', '--start', 'make serve']);
  const shown = run(root, ['harness']);
  assert.match(shown, /Start:\s+make serve/);
  assert.doesNotMatch(shown, /Setup:/);
  assert.doesNotMatch(shown, /Probe:/);
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

/** Write a one-step e2e.json for the fixture change; exit code drives red/green. */
function writeLoop(root, exitCode) {
  fs.writeFileSync(
    path.join(root, 'specs', 'changes', 'my-change', 'e2e.json'),
    `${JSON.stringify({ steps: [{ name: 'smoke', cmd: `node -e "process.exit(${exitCode})"` }] })}\n`,
    'utf8',
  );
}

const SETUP_CMD = 'npx playwright install chromium';

test('a red loop names the recorded harness setup as the first suspicion', () => {
  // The reported failure mode: the agent's sandbox already had the browsers, so
  // the operator's fresh checkout read a missing runtime as a code regression.
  const root = tmp('e2e-hint-red-');
  makeFixture(root);
  run(root, ['harness', '--set', 'preview + playwright', '--start', 'npm run preview', '--setup', SETUP_CMD]);
  writeLoop(root, 1);

  const out = runAllowFail(root, ['run']);
  assert.match(out, /Harness setup recorded/);
  assert.match(out, new RegExp(SETUP_CMD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Advisory only — the failing step stays the headline and drives the exit code.
  assert.match(out, /FAILED/);
  assert.ok(out.indexOf(SETUP_CMD) < out.indexOf('FAILED'), `hint must precede the verdict:\n${out}`);
  assert.throws(() => run(root, ['run']), 'a red loop must still exit non-zero');
});

test('no prerequisite hint without a recorded setup, or on a green loop', () => {
  const noSetup = tmp('e2e-hint-none-');
  makeFixture(noSetup);
  run(noSetup, ['harness', '--set', 'preview only', '--start', 'npm run preview']);
  writeLoop(noSetup, 1);
  const red = runAllowFail(noSetup, ['run']);
  assert.match(red, /FAILED/);
  assert.doesNotMatch(red, /Harness setup recorded/);

  const green = tmp('e2e-hint-green-');
  makeFixture(green);
  run(green, ['harness', '--set', 'preview + playwright', '--setup', SETUP_CMD]);
  writeLoop(green, 0);
  const ok = run(green, ['run']);
  assert.match(ok, /GREEN/);
  assert.doesNotMatch(ok, /Harness setup recorded/);
});

test('e2e run --repeat measures flakiness instead of trusting one green run', () => {
  // volo's smoke suite pinned --workers=1 in 6/6 changes to route around a
  // race nobody fixed, and the server suite's clean-tree baseline was "1-4
  // varying failures" — invisible to every verify phase.
  const root = tmp('forge-e2e-repeat-');
  makeFixture(root);
  const changeDir = path.join(root, 'specs', 'changes', 'my-change');
  // Portable counter: steps run through `shell: true`, which is cmd.exe on
  // Windows, so POSIX `$(cat …)`/`test` would fail every run and read as
  // BROKEN rather than FLAKY. Single quotes only — the outer quoting is `"`.
  const counter = path.join(root, 'runs.txt').replace(/\\/g, '/');
  // Fails on the 2nd invocation only: a textbook flake.
  const cmd = `node -e "const fs=require('fs');const f='${counter}';let n=0;try{n=Number(fs.readFileSync(f,'utf8'))||0}catch(e){};n++;fs.writeFileSync(f,String(n));process.exit(n===2?1:0)"`;
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
