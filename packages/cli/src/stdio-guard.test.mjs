import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import stdioGuard from './stdio-guard.cjs';

const { installBrokenPipeGuard, removeInjectedNodeOption } = stdioGuard;

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORGE = path.join(SRC, '..', 'bin', 'forge.mjs');


test('removing the injected preload preserves pre-existing quoted NODE_OPTIONS exactly', () => {
  const inherited = '--require "/tmp/a b.js" --trace-warnings';
  const injected = '--require="/tmp/stdio guard.cjs"';
  assert.equal(removeInjectedNodeOption(`${injected} ${inherited}`, injected), inherited);
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


test('injected guard is removed before an inherited preload can spawn descendants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stdio-preload-'));
  const probe = path.join(dir, 'probe.cjs');
  const leaked = path.join(dir, 'leaked.json');
  fs.writeFileSync(probe, `
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    if (process.env.FORGEKIT_STDIO_GUARD_OPTION && !process.env.FORGE_STDIO_PROBE_CHILD) {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ options: process.env.NODE_OPTIONS, marker: process.env.FORGEKIT_STDIO_GUARD_OPTION }))'], {
        encoding: 'utf8',
        env: { ...process.env, FORGE_STDIO_PROBE_CHILD: '1' },
      });
      fs.writeFileSync(${JSON.stringify(leaked)}, r.stdout);
    }
  `);
  const inherited = `--require=${JSON.stringify(probe)} --trace-warnings`;
  const r = spawnSync(process.execPath, [FORGE, 'prefs'], {
    cwd: path.join(SRC, '..', '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: inherited },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(leaked), false, fs.existsSync(leaked) ? fs.readFileSync(leaked, 'utf8') : '');
});

test('forge prefs piped to an early-closing consumer has no EPIPE stack trace', { skip: process.platform === 'win32' }, () => {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(FORGE)} prefs | head -n 1`;
  const r = spawnSync('bash', ['-o', 'pipefail', '-c', command], { cwd: path.join(SRC, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled 'error' event/);
});
