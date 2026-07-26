import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CLI_ROOT, isVersionFlag, readVersion, versionLine } from './version.mjs';

const BIN = path.join(CLI_ROOT, 'bin');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'),
).version;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/** A package root holding just a manifest. */
function fakeRoot(manifest) {
  const dir = tmp('forgekit-version-');
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), manifest, 'utf8');
  }
  return dir;
}

function runBin(bin, args) {
  const r = spawnSync(process.execPath, [path.join(BIN, bin), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('isVersionFlag accepts the two spellings and nothing else', () => {
  assert.equal(isVersionFlag('--version'), true);
  assert.equal(isVersionFlag('-v'), true);
  assert.equal(isVersionFlag('--help'), false);
  assert.equal(isVersionFlag('version'), false);
  assert.equal(isVersionFlag(undefined), false);
});

test('readVersion reads the package manifest, not a hardcoded string', () => {
  assert.equal(readVersion(), PKG_VERSION);
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(readVersion(fakeRoot('{"version":"9.9.9"}')), '9.9.9');
});

test('readVersion degrades to `unknown` rather than throwing', () => {
  assert.equal(readVersion(fakeRoot(null)), 'unknown', 'no manifest');
  assert.equal(readVersion(fakeRoot('{ not json')), 'unknown', 'corrupt manifest');
  assert.equal(readVersion(fakeRoot('{"name":"x"}')), 'unknown', 'manifest without a version');
  assert.equal(readVersion(fakeRoot('{"version":""}')), 'unknown', 'empty version');
});

test('versionLine names the bin, since three of them share one package', () => {
  assert.equal(versionLine('forge', fakeRoot('{"version":"9.9.9"}')), 'forge 9.9.9\n');
});

test('every bin answers --version and -v with its own name', () => {
  for (const bin of ['forge.mjs', 'forgekit.mjs', 'review.mjs']) {
    const name = path.basename(bin, '.mjs');
    for (const flag of ['--version', '-v']) {
      const r = runBin(bin, [flag]);
      assert.equal(r.status, 0, `${name} ${flag} exited ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, `${name} ${PKG_VERSION}\n`);
    }
  }
});

test('--version does not shadow a real command', () => {
  const r = runBin('forge.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /forge --version/, 'help advertises the flag');
  assert.doesNotMatch(r.stdout, /^forge \d+\.\d+\.\d+\n$/);
});
