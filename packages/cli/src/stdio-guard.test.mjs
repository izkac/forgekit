import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installBrokenPipeGuard, removeInjectedNodeOption } from './stdio-guard.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORGE = path.join(SRC, '..', 'bin', 'forge.mjs');


test('removing the injected preload preserves pre-existing quoted NODE_OPTIONS exactly', () => {
  const inherited = '--require "/tmp/a b.js" --trace-warnings';
  const injected = '--import=file:///tmp/stdio-guard.mjs';
  assert.equal(removeInjectedNodeOption(`${inherited} ${injected}`, injected), inherited);
  assert.equal(removeInjectedNodeOption(injected, injected), '');
});

test('EPIPE exits successfully while non-EPIPE stdout errors remain fatal', () => {
  const stream = new EventEmitter();
  let exitCode = null;
  installBrokenPipeGuard(stream, (code) => { exitCode = code; });
  stream.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
  assert.equal(exitCode, 0);
  assert.throws(() => stream.emit('error', Object.assign(new Error('bad fd'), { code: 'EBADF' })), /bad fd/);
});

test('forge prefs piped to an early-closing consumer has no EPIPE stack trace', { skip: process.platform === 'win32' }, () => {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(FORGE)} prefs | head -n 1`;
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', command], { cwd: path.join(SRC, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled 'error' event/);
});
