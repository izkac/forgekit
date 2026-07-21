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
