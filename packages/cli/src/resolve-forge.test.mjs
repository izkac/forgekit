/**
 * `templates/project/claude/hooks/resolve-forge.mjs` — shared helper so
 * shipped hooks spawn `node` + `forge.mjs` with `shell: false` on every
 * platform (Windows `.cmd` shims never reach cmd.exe).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveTemplatesRoot } from './init.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SRC, '..', '..', '..');
const REAL_FORGE_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'forge.mjs');

const CLAUDE_HELPER = path.join(resolveTemplatesRoot(), 'claude', 'hooks', 'resolve-forge.mjs');
const CURSOR_HELPER = path.join(resolveTemplatesRoot(), 'cursor', 'hooks', 'resolve-forge.mjs');
const REPO_CLAUDE_HELPER = path.join(REPO_ROOT, '.claude', 'hooks', 'resolve-forge.mjs');
const REPO_CURSOR_HELPER = path.join(REPO_ROOT, '.cursor', 'hooks', 'resolve-forge.mjs');

const {
  parseQuotedCommand,
  resolveFromCmdShim,
  resolveForgeMjs,
  resolveForgeInvocation,
} = await import(pathToFileURL(CLAUDE_HELPER).href);

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeExecutable(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

test('parseQuotedCommand: splits space-quoted tokens and always returns shell:false', () => {
  const parsed = parseQuotedCommand(`"${process.execPath}" "${REAL_FORGE_BIN}"`);
  assert.deepEqual(parsed, {
    cmd: process.execPath,
    baseArgs: [REAL_FORGE_BIN],
    shell: false,
  });
  assert.equal(parseQuotedCommand(''), null);
  assert.equal(parseQuotedCommand('   '), null);
});

test('resolveForgeMjs: a PATH hit that is already forge.mjs is used as-is', () => {
  const dir = tmp('resolve-forge-mjs-');
  const mjs = writeExecutable(dir, 'forge.mjs', 'export {}\n');
  assert.equal(resolveForgeMjs({ path: dir }), mjs);
});

test('resolveForgeMjs: a shebang `forge` on PATH is treated as the node script', () => {
  const dir = tmp('resolve-forge-shebang-');
  const script = writeExecutable(
    dir,
    'forge',
    '#!/usr/bin/env node\nconsole.log("ok")\n',
  );
  assert.equal(resolveForgeMjs({ path: dir }), script);
});

test('resolveFromCmdShim: reads the quoted forge.mjs path out of an npm-style .cmd', () => {
  const dir = tmp('resolve-forge-cmd-');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mjs = writeExecutable(binDir, 'forge.mjs', 'export {}\n');
  const cmd = path.join(dir, 'forge.cmd');
  // npm's real shim quotes `%~dp0\bin\forge.mjs` with backslashes. The
  // helper must resolve that on Linux CI too, not only on win32.
  fs.writeFileSync(cmd, `@ECHO off\n"%~dp0\\bin\\forge.mjs" %*\n`);
  assert.equal(resolveFromCmdShim(cmd), mjs);
});

test('resolveFromCmdShim: falls back to the npm-global sibling layout', () => {
  const prefix = tmp('resolve-forge-npm-global-');
  const mjs = path.join(prefix, 'node_modules', '@izkac', 'forgekit', 'bin', 'forge.mjs');
  fs.mkdirSync(path.dirname(mjs), { recursive: true });
  fs.writeFileSync(mjs, 'export {}\n');
  const cmd = path.join(prefix, 'forge.cmd');
  fs.writeFileSync(cmd, '@ECHO off\nREM no quoted path in this fixture\n');
  assert.equal(resolveFromCmdShim(cmd), mjs);
});

test('resolveForgeInvocation: override wins; default is node + forge.mjs; shell is always false', () => {
  const override = resolveForgeInvocation({
    override: `"${process.execPath}" "${REAL_FORGE_BIN}"`,
  });
  assert.equal(override.shell, false);
  assert.equal(override.cmd, process.execPath);
  assert.deepEqual(override.baseArgs, [REAL_FORGE_BIN]);

  const dir = tmp('resolve-forge-inv-');
  const mjs = writeExecutable(dir, 'forge.mjs', 'export {}\n');
  const resolved = resolveForgeInvocation({ path: dir });
  assert.deepEqual(resolved, { cmd: process.execPath, baseArgs: [mjs], shell: false });

  const missing = resolveForgeInvocation({ path: path.join(dir, 'empty') });
  assert.deepEqual(missing, { cmd: 'forge', baseArgs: [], shell: false });
});

test('resolveForgeInvocation: a resolved bin actually runs (help path)', () => {
  const { cmd, baseArgs, shell } = resolveForgeInvocation({
    override: `"${process.execPath}" "${REAL_FORGE_BIN}"`,
  });
  assert.equal(shell, false);
  const r = spawnSync(cmd, [...baseArgs, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /forge/);
});

test('claude and cursor template helpers, and the in-repo copies, stay byte-identical', () => {
  const canonical = fs.readFileSync(CLAUDE_HELPER);
  assert.ok(canonical.equals(fs.readFileSync(CURSOR_HELPER)), 'cursor template helper drifted');
  assert.ok(canonical.equals(fs.readFileSync(REPO_CLAUDE_HELPER)), '.claude/hooks helper drifted');
  assert.ok(canonical.equals(fs.readFileSync(REPO_CURSOR_HELPER)), '.cursor/hooks helper drifted');
});

const CLAUDE_HOOK_DIR = path.join(resolveTemplatesRoot(), 'claude', 'hooks');
const CURSOR_HOOK_DIR = path.join(resolveTemplatesRoot(), 'cursor', 'hooks');

test('shipped forge-*.mjs hooks spawn via resolveForgeInvocation and never set shell:true', () => {
  const dirs = [CLAUDE_HOOK_DIR, CURSOR_HOOK_DIR];
  /** @type {string[]} */
  const hooks = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (/^forge-.*\.mjs$/.test(name)) hooks.push(path.join(dir, name));
    }
  }
  assert.ok(hooks.length >= 5, `expected shipped hooks, got ${hooks.length}`);
  for (const file of hooks) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /resolveForgeInvocation/, `${path.basename(file)} must use the helper`);
    assert.doesNotMatch(
      src,
      /shell:\s*true/,
      `${path.basename(file)} must not set shell: true`,
    );
    assert.match(src, /shell:\s*false/, `${path.basename(file)} must spawn with shell: false`);
  }
});
