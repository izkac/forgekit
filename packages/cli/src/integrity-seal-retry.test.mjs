import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkIntegritySeal,
  integritySealPath,
  refreshIntegritySeal,
} from './integrity-seal.mjs';

function makeSession() {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'forge-seal-retry-'));
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', phase: 'implement' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(cwd, '.forge', 'active.json'),
    `${JSON.stringify({ sessionId: 's1' }, null, 2)}\n`,
    'utf8',
  );
  return { cwd, sessionDir };
}

/** fs whose writeFileSync throws `code` for the first `failures` calls. */
function flakyFs(code, failures) {
  const state = { writes: 0 };
  const impl = {
    ...fs,
    writeFileSync(...args) {
      state.writes += 1;
      if (state.writes <= failures) {
        throw Object.assign(new Error(`${code}: injected`), { code });
      }
      return fs.writeFileSync(...args);
    },
  };
  return { impl, state };
}

function silenceStderr(fn) {
  const orig = process.stderr.write;
  /** @type {string[]} */
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

function leftoverTmp(sessionDir) {
  return fs.readdirSync(sessionDir).filter((n) => n.endsWith('.tmp'));
}

test('seal refresh retries a transient EBUSY and leaves a seal matching the current files', () => {
  const { cwd, sessionDir } = makeSession();
  // Seal the original files, then legitimately change one — the old seal is now stale.
  assert.ok(refreshIntegritySeal({ sessionDir, repoRoot: cwd }));
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', phase: 'verify' }, null, 2)}\n`,
    'utf8',
  );
  assert.ok(checkIntegritySeal({ sessionDir, repoRoot: cwd }).problems.length > 0);

  const { impl, state } = flakyFs('EBUSY', 1);
  const { result, lines } = silenceStderr(() =>
    refreshIntegritySeal({ sessionDir, repoRoot: cwd, fsImpl: impl }),
  );

  assert.ok(result, 'refresh must succeed after one transient failure');
  assert.equal(state.writes, 2, 'one failed write plus one successful retry');
  assert.deepEqual(lines, [], 'a recovered retry must not warn');
  assert.deepEqual(checkIntegritySeal({ sessionDir, repoRoot: cwd }).problems, []);
  assert.deepEqual(leftoverTmp(sessionDir), []);
  const sealed = JSON.parse(fs.readFileSync(integritySealPath(sessionDir), 'utf8'));
  assert.deepEqual(sealed, result.fingerprint);
});

test('seal refresh retries three times (four attempts) on a persistent transient error, then warns', () => {
  const { cwd, sessionDir } = makeSession();
  const { impl, state } = flakyFs('EPERM', Infinity);
  const { result, lines } = silenceStderr(() =>
    refreshIntegritySeal({ sessionDir, repoRoot: cwd, fsImpl: impl }),
  );
  assert.equal(result, null);
  const retries = 3; // spec: "retry the refresh up to three times"
  assert.equal(state.writes, 1 + retries);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not refresh integrity seal/);
  assert.equal(fs.existsSync(integritySealPath(sessionDir)), false);
  assert.deepEqual(leftoverTmp(sessionDir), []);
});

test('seal refresh does not retry a non-transient error', () => {
  const { cwd, sessionDir } = makeSession();
  const { impl, state } = flakyFs('ENOSPC', Infinity);
  const { result, lines } = silenceStderr(() =>
    refreshIntegritySeal({ sessionDir, repoRoot: cwd, fsImpl: impl }),
  );
  assert.equal(result, null);
  assert.equal(state.writes, 1);
  assert.equal(lines.length, 1);
  assert.deepEqual(leftoverTmp(sessionDir), []);
});

test('seal refresh retries a transient rename failure and cleans its temp file', () => {
  const { cwd, sessionDir } = makeSession();
  let renames = 0;
  const impl = {
    ...fs,
    renameSync(...args) {
      renames += 1;
      if (renames === 1) throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
      return fs.renameSync(...args);
    },
  };
  const { result, lines } = silenceStderr(() => refreshIntegritySeal({ sessionDir, repoRoot: cwd, fsImpl: impl }));
  assert.ok(result);
  assert.equal(renames, 2);
  assert.deepEqual(lines, []);
  assert.deepEqual(leftoverTmp(sessionDir), []);
  assert.deepEqual(checkIntegritySeal({ sessionDir, repoRoot: cwd }).problems, []);
});
