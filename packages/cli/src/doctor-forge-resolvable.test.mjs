/**
 * `forge doctor` reports whether the shipped hooks' resolver can find a
 * `forge.mjs`. When it cannot, every forge hook (the lease guard included) is
 * inert, and the report must say so and tell the operator how to fix the PATH.
 * Kept apart from doctor.test.mjs (guarded).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as doctor from './doctor.mjs';

const { checkHookForgeResolvable, runDoctor, runDoctorChecks } = doctor;

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORGE_MJS = path.resolve(SRC, '..', 'bin', 'forge.mjs');
const OVERRIDE = `"${process.execPath}" "${FORGE_MJS}"`;

/** An environment where nothing can be found: empty PATH, no override. */
const NOTHING = { PATH: '', FORGE_HOOK_FORGE_CMD: undefined };

function withDir(prefix, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolvable through FORGE_HOOK_FORGE_CMD: ok, and the message names the command hooks will run', () => {
  const check = checkHookForgeResolvable({ env: { ...NOTHING, FORGE_HOOK_FORGE_CMD: OVERRIDE } });
  assert.equal(check.id, 'hook-forge-resolvable');
  assert.equal(check.ok, true);
  assert.ok(check.message.includes(FORGE_MJS), check.message);
  assert.ok(check.message.includes('FORGE_HOOK_FORGE_CMD'), check.message);
});

test('resolvable through PATH: ok, and the message names the forge.mjs found', () => {
  withDir('doctor-forge-path-', (bin) => {
    const script = path.join(bin, 'forge.mjs');
    fs.writeFileSync(script, '// stand-in\n', 'utf8');
    const check = checkHookForgeResolvable({ env: { ...NOTHING, PATH: bin } });
    assert.equal(check.ok, true, check.message);
    assert.equal(check.resolved, fs.realpathSync(script));
    assert.ok(check.message.includes(check.resolved), check.message);
  });
});

test('unresolvable (empty PATH, no override): not ok, hooks are inert, tells the operator to fix PATH', () => {
  const check = checkHookForgeResolvable({ env: NOTHING });
  assert.equal(check.id, 'hook-forge-resolvable');
  assert.equal(check.ok, false);
  assert.equal(check.resolved, null);
  assert.match(check.message, /inert/);
  assert.match(check.message, /lease guard/);
  assert.match(check.message, /PATH of the process that launches the agent/);
  assert.match(check.message, /background[- ]service orchestrator/i);
  assert.ok(check.message.includes('FORGE_HOOK_FORGE_CMD'), 'names the override as the alternative');
});

test('an empty-string override counts as no override', () => {
  const check = checkHookForgeResolvable({ env: { PATH: '', FORGE_HOOK_FORGE_CMD: '   ' } });
  assert.equal(check.ok, false);
});

test('runDoctorChecks carries the check without changing the overall verdict or exit code', () => {
  withDir('doctor-forge-report-', (cwd) => {
    const found = runDoctorChecks({ cwd, env: { ...NOTHING, FORGE_HOOK_FORGE_CMD: OVERRIDE } });
    const missing = runDoctorChecks({ cwd, env: NOTHING });
    assert.equal(found.checks.hookForge.ok, true);
    assert.equal(missing.checks.hookForge.ok, false);
    assert.equal(missing.ok, found.ok, 'an unresolvable forge on this process PATH is a warning, not a failed doctor run');
  });
});

test('forge doctor prints the warning line for an unresolvable forge, and an ok line otherwise', () => {
  withDir('doctor-forge-print-', (cwd) => {
    const run = (env) => {
      let out = '';
      const stdout = { write: (s) => (out += s) };
      const code = runDoctor([], { cwd, stdout, stderr: { write() {} }, env });
      return { out, code };
    };
    const bad = run(NOTHING);
    assert.match(bad.out, /\[warn\] .*inert/);
    const good = run({ ...NOTHING, FORGE_HOOK_FORGE_CMD: OVERRIDE });
    assert.match(good.out, /\[ok\] .*forge\.mjs/);
    assert.doesNotMatch(good.out, /inert/);
    assert.equal(bad.code, good.code, 'the exit code does not depend on the hook resolver');
  });
});
