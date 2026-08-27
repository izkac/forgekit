/**
 * `templates/project/claude/hooks/forge-prompt-hook.mjs` — UserPromptSubmit
 * hook that relays the raw user prompt to `forge` via spawnSync. With
 * shell:true, Node joins argv into an unquoted command string, so any shell
 * metacharacter in the prompt is interpreted rather than passed through
 * (finding F79).
 *
 * These tests prove: (1) the injection is closed — shell metacharacters in
 * a prompt never execute; (2) the prompt still reaches `forge` byte-for-byte
 * unchanged, including metacharacters and quotes; (3) the template and
 * `.claude/hooks` copies stay identical; (4) the hook fires on `/forge` and
 * "use Forge", not on a plain work request.
 *
 * The win32 branch (where `forge` is a `.cmd` shim and needs a shell) is
 * NOT exercised here: forcing `process.platform` to `'win32'` also flips
 * Node's own internal shell selection for `shell: true` to `cmd.exe`, which
 * does not exist on this host, so `spawnSync` fails at the OS level before
 * the hook's quoting logic ever runs — a false pass, not a real one. This
 * matches `forge-test-guard.test.mjs` (the precedent this fix mirrors),
 * which does not attempt to test that branch either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTemplatesRoot } from './init.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SRC, '..', '..', '..');
const POSIX_ONLY = { skip: process.platform === 'win32' };

const HOOK_NAMES = ['forge-prompt-hook.mjs'];
const TEMPLATE_HOOKS = Object.fromEntries(
  HOOK_NAMES.map((name) => [name, path.join(resolveTemplatesRoot(), 'claude', 'hooks', name)]),
);
const REPO_HOOKS = Object.fromEntries(
  HOOK_NAMES.map((name) => [name, path.join(REPO_ROOT, '.claude', 'hooks', name)]),
);

// A prompt that opens the hook's own gate, so the run actually reaches the
// prompt-carrying spawn site instead of short-circuiting before it. The
// prompt hook only relays past `isForgeInvocation`.
const LEAD_IN = {
  'forge-prompt-hook.mjs': '/forge ',
};

// forge-prompt-hook.mjs: one site (`forge reminder --prompt <p>`).
const PROMPT_SITES = {
  'forge-prompt-hook.mjs': {
    count: 1,
    isPromptBearing: (argv) => argv[0] === 'reminder',
  },
};

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A scratch project dir; `.forge/active.json` is required by the prompt hook. */
function makeProject({ withActiveSession = true } = {}) {
  const root = tmp('hook-injection-');
  if (withActiveSession) {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'active.json'), JSON.stringify({ sessionId: 's1' }), 'utf8');
  }
  return root;
}

/**
 * A stand-in `forge` executable placed first on PATH: it records the argv it
 * was invoked with (one JSON line per call, in call order) to FORGE_STUB_LOG
 * and always exits 0 with non-empty stdout, so callers that branch on the
 * exit status (`forge triage --check`) proceed to their next call.
 */
function makeForgeStub(dir) {
  const stubPath = path.join(dir, 'forge');
  fs.writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const logFile = process.env.FORGE_STUB_LOG;',
      'if (logFile) fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");',
      'process.stdout.write("stub-ok\\n");',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function readStubCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).argv);
}

/**
 * @param {string} hookPath
 * @param {string} root cwd for the hook process (== CLAUDE_PROJECT_DIR)
 * @param {{ prompt?: string, stubDir?: string, logFile?: string }} opts
 */
function runHook(hookPath, root, opts) {
  const payload = { prompt: opts.prompt };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  if (opts.stubDir) env.PATH = `${opts.stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
  if (opts.logFile) env.FORGE_STUB_LOG = opts.logFile;

  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: root,
    env,
  });
}

for (const name of HOOK_NAMES) {
  const HOOK = TEMPLATE_HOOKS[name];

  test(`${name}: never executes shell metacharacters embedded in the prompt (command injection)`, POSIX_ONLY, () => {
    // A stub `forge` on PATH keeps `forge reminder` deterministic (exit
    // 0 always) so the run reaches the prompt-carrying site.
    const root = makeProject();
    const stubDir = tmp('hook-injection-stub-');
    makeForgeStub(stubDir);
    const markerDir = tmp('hook-injection-pwn-');
    const marker = path.join(markerDir, 'PWNED');
    const prompt = `${LEAD_IN[name]}hello; touch ${marker} #`;
    const r = runHook(HOOK, root, { prompt, stubDir });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(marker), 'prompt text must never reach a shell as a command');
  });

  test(`${name}: relays a prompt with shell metacharacters to forge byte-for-byte unchanged at every prompt-bearing spawn site`, POSIX_ONLY, () => {
    const root = makeProject();
    const stubDir = tmp('hook-injection-stub-');
    const logFile = path.join(stubDir, 'calls.jsonl');
    makeForgeStub(stubDir);
    const prompt = `${LEAD_IN[name]}\`bt\` $(sub) ; pipe | "dq" 'sq'\nnewline-tail`;
    const r = runHook(HOOK, root, { prompt, stubDir, logFile });
    assert.equal(r.status, 0, r.stderr);
    const calls = readStubCalls(logFile);
    const { count, isPromptBearing } = PROMPT_SITES[name];
    const promptBearingCalls = calls.filter(isPromptBearing);
    // The count alone catches a dropped call (mutant removes a whole spawn
    // site, or removes the arg so the site no longer structurally matches);
    // `.every()` alone would pass vacuously on an empty array, so both are
    // required — count that the right number of sites fired, then that each
    // one actually carried the unmodified prompt.
    assert.equal(
      promptBearingCalls.length,
      count,
      `expected ${count} prompt-bearing call(s) for ${name}, got ${JSON.stringify(calls)}`,
    );
    assert.ok(
      promptBearingCalls.every((argv) => argv.includes(prompt)),
      `every prompt-bearing call must carry the exact prompt, got ${JSON.stringify(promptBearingCalls)}`,
    );
  });
}

test('template and .claude copies of forge-prompt-hook.mjs are byte-identical', () => {
  for (const name of HOOK_NAMES) {
    assert.ok(fs.existsSync(TEMPLATE_HOOKS[name]), `missing ${TEMPLATE_HOOKS[name]}`);
    assert.ok(fs.existsSync(REPO_HOOKS[name]), `missing ${REPO_HOOKS[name]}`);
    assert.ok(
      fs.readFileSync(TEMPLATE_HOOKS[name]).equals(fs.readFileSync(REPO_HOOKS[name])),
      `templates/project/claude/hooks/${name} and .claude/hooks/${name} must be in sync`,
    );
  }
});

test('retired forge-triage-hook.mjs is not shipped in templates', () => {
  const name = 'forge-triage-hook.mjs';
  assert.equal(
    fs.existsSync(path.join(resolveTemplatesRoot(), 'claude', 'hooks', name)),
    false,
  );
});

test('prompt hook matcher stays in sync with isForgeInvocation', () => {
  const hookSrc = fs.readFileSync(TEMPLATE_HOOKS['forge-prompt-hook.mjs'], 'utf8');
  const cliSrc = fs.readFileSync(path.join(SRC, 'triage-prompt.mjs'), 'utf8');
  const needle = String.raw`/\b(?:use(?:\s+the)?|using)\s+forge\b/i`;
  assert.ok(hookSrc.includes(needle), 'prompt hook missing the use-Forge matcher');
  assert.ok(cliSrc.includes(needle), 'triage-prompt.mjs missing the use-Forge matcher');
});

test('prompt hook fires on natural-language use Forge', POSIX_ONLY, () => {
  const root = makeProject();
  const stubDir = tmp('hook-use-forge-stub-');
  const logFile = path.join(stubDir, 'calls.jsonl');
  makeForgeStub(stubDir);
  const r = runHook(TEMPLATE_HOOKS['forge-prompt-hook.mjs'], root, {
    prompt: 'Use Forge. Add a health endpoint.',
    stubDir,
    logFile,
  });
  assert.equal(r.status, 0, r.stderr);
  const calls = readStubCalls(logFile);
  assert.ok(
    calls.some((argv) => argv[0] === 'reminder'),
    `expected a reminder call, got ${JSON.stringify(calls)}`,
  );
});

test('prompt hook stays silent on a plain work request', POSIX_ONLY, () => {
  const root = makeProject();
  const stubDir = tmp('hook-plain-stub-');
  const logFile = path.join(stubDir, 'calls.jsonl');
  makeForgeStub(stubDir);
  const r = runHook(TEMPLATE_HOOKS['forge-prompt-hook.mjs'], root, {
    prompt: 'Add rate limiting to the public API.',
    stubDir,
    logFile,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readStubCalls(logFile), []);
  assert.equal((r.stdout || '').includes('[forge]'), false);
});
