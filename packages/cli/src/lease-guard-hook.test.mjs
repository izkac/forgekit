/**
 * `templates/project/claude/hooks/forge-lease-guard.mjs` — the PreToolUse hook
 * (Claude Code `Bash|PowerShell`, Cursor `Shell`) that denies commands matching
 * a configured lease and tells the agent to rerun them as `forge lease <name> --`.
 *
 * The decision lives in `forge lease check` (lease-cli.test.mjs proves it);
 * these tests prove the hook's own job: the fast path that never spawns forge,
 * the host-specific deny shape, deny-only output, and fail-open on every error.
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
const FORGE_MJS = path.resolve(SRC, '..', 'bin', 'forge.mjs');
const TEMPLATES = resolveTemplatesRoot();
const CLAUDE_HOOK = path.join(TEMPLATES, 'claude', 'hooks', 'forge-lease-guard.mjs');
const CURSOR_HOOK = path.join(TEMPLATES, 'cursor', 'hooks', 'forge-lease-guard.mjs');

const LEASE_NAME = 'db';
const LEASE_PATTERN = 'prisma migrate';
const MATCHING = 'npx prisma migrate dev';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** @param {unknown} [config] contents of `.forge/config.json`; omitted = no file */
function makeProject(config) {
  const root = tmp('lease-guard-hook-');
  if (config !== undefined) {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.forge', 'config.json'),
      typeof config === 'string' ? config : `${JSON.stringify(config)}\n`,
      'utf8',
    );
  }
  return root;
}

const leaseConfig = () => ({ leases: { [LEASE_NAME]: { match: [LEASE_PATTERN] } } });

/** This checkout's CLI, in the quoted-command form `resolve-forge.mjs` accepts. */
const OWN_FORGE = `"${process.execPath}" "${FORGE_MJS}"`;

/**
 * @param {string} hook
 * @param {string} root cwd of the hook process
 * @param {{ payload?: unknown, raw?: string, args?: string[], env?: Record<string, string> }} [opts]
 */
function runHook(hook, root, opts = {}) {
  const input = opts.raw !== undefined ? opts.raw : JSON.stringify(opts.payload);
  return spawnSync(process.execPath, [hook, ...(opts.args ?? [])], {
    input,
    encoding: 'utf8',
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      FORGE_HOOK_FORGE_CMD: OWN_FORGE,
      ...(opts.env ?? {}),
    },
  });
}

const claudePayload = (command, tool_name = 'Bash') => ({ tool_name, tool_input: { command } });

/** The hook only ever denies: whatever it printed must carry no allow/ask/rewrite. */
function assertDenyOnly(r) {
  assert.doesNotMatch(r.stdout, /"allow"/);
  assert.doesNotMatch(r.stdout, /"ask"/);
  assert.doesNotMatch(r.stdout, /updatedInput|updated_input/);
}

function warningLines(r) {
  return r.stderr.split(/\r?\n/).filter((l) => l.trim());
}

test('claude: a Bash command matching a lease is denied with the wrap instruction', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { payload: claudePayload(MATCHING) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(`forge lease ${LEASE_NAME} --`), reason);
  assert.ok(reason.includes(MATCHING), 'reason carries the original command');
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(r.stderr, '');
  assertDenyOnly(r);
});

test('claude: the PowerShell tool is guarded exactly like Bash', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { payload: claudePayload(MATCHING, 'PowerShell') });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(`forge lease ${LEASE_NAME} --`));
  assertDenyOnly(r);
});

test('claude: a command no lease matches produces no output at all', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { payload: claudePayload('ls -la') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('claude: a command already wrapped in forge lease is left alone', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { payload: claudePayload(`forge lease ${LEASE_NAME} -- ${MATCHING}`) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('claude: other tools are ignored even when their input would match', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, {
    payload: { tool_name: 'Edit', tool_input: { command: MATCHING, file_path: 'x' } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('fast path: no .forge/config.json means exit 0, no output, and forge is never spawned', () => {
  const root = makeProject();
  // If the hook spawned forge it would hit this missing binary and warn on stderr.
  const missing = path.join(root, 'no-such-forge');
  const r = runHook(CLAUDE_HOOK, root, {
    payload: claudePayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${missing}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('fast path: a config with no lease match entries never spawns forge either', () => {
  const missing = path.join(tmpdir(), 'no-such-forge-binary');
  for (const config of [
    {},
    { leases: {} },
    { leases: { [LEASE_NAME]: { waitMs: 1000 } } },
    { leases: { [LEASE_NAME]: { match: [] } } },
    '{ not json',
  ]) {
    const root = makeProject(config);
    const r = runHook(CLAUDE_HOOK, root, {
      payload: claudePayload(MATCHING),
      env: { FORGE_HOOK_FORGE_CMD: `"${missing}"` },
    });
    assert.equal(r.status, 0, `${JSON.stringify(config)}: ${r.stderr}`);
    assert.equal(r.stdout, '', JSON.stringify(config));
    assert.equal(r.stderr, '', JSON.stringify(config));
  }
});

test('fail open: unparseable stdin exits 0, prints nothing, warns once', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { raw: 'this is not json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = warningLines(r);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^\[forge\] Warning: .+ — lease-guard allowing\.$/);
});

test('fail open: a non-string command warns once and allows', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, { payload: { tool_name: 'Bash', tool_input: { command: 42 } } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(warningLines(r).length, 1, r.stderr);
  assert.match(r.stderr, /lease-guard allowing\./);
});

test('fail open: forge that cannot be spawned warns once and allows', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CLAUDE_HOOK, root, {
    payload: claudePayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${path.join(root, 'no-such-forge')}"` },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(warningLines(r).length, 1, r.stderr);
  assert.match(r.stderr, /lease-guard allowing\./);
});

test('fail open: forge exiting non-zero warns once and allows', () => {
  const root = makeProject(leaseConfig());
  const failing = path.join(root, 'fail.mjs');
  fs.writeFileSync(failing, 'process.exit(3);\n', 'utf8');
  const r = runHook(CLAUDE_HOOK, root, {
    payload: claudePayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${process.execPath}" "${failing}"` },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(warningLines(r).length, 1, r.stderr);
});

test('fail open: forge printing something other than the check JSON warns once and allows', () => {
  const root = makeProject(leaseConfig());
  const noisy = path.join(root, 'noisy.mjs');
  fs.writeFileSync(noisy, "console.log('not json');\n", 'utf8');
  const r = runHook(CLAUDE_HOOK, root, {
    payload: claudePayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${process.execPath}" "${noisy}"` },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(warningLines(r).length, 1, r.stderr);
});

test('deny-only: even a forge reply that says "allow" cannot make the hook emit a decision', () => {
  const root = makeProject(leaseConfig());
  const lying = path.join(root, 'lying.mjs');
  fs.writeFileSync(lying, `console.log(JSON.stringify({ action: 'allow', updatedInput: { command: 'x' } }));\n`, 'utf8');
  const r = runHook(CLAUDE_HOOK, root, {
    payload: claudePayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${process.execPath}" "${lying}"` },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assertDenyOnly(r);
});

test('the hook passes the command through argv untouched, shell metacharacters and all', () => {
  const root = makeProject({ leases: { [LEASE_NAME]: { match: ['prisma migrate'] } } });
  const command = `npx prisma migrate dev "$(echo hi)" & echo 'x' | cat > out.txt`;
  const r = runHook(CLAUDE_HOOK, root, { payload: claudePayload(command) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(command));
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false, 'nothing was interpreted by a shell');
});

test('the hook source spawns without a shell', () => {
  const src = fs.readFileSync(CLAUDE_HOOK, 'utf8');
  assert.match(src, /shell:\s*false/);
  assert.doesNotMatch(src, /shell:\s*true/);
});

test('the template hook and this repository .claude/hooks copy are byte-identical', () => {
  const copy = path.join(REPO_ROOT, '.claude', 'hooks', 'forge-lease-guard.mjs');
  assert.ok(fs.existsSync(copy), `${copy} exists`);
  assert.ok(fs.readFileSync(CLAUDE_HOOK).equals(fs.readFileSync(copy)));
});

// --- Cursor: `--format cursor`, preToolUse, matcher Shell ---------------------

const cursorPayload = (command, tool_name = 'Shell') => ({
  tool_name,
  tool_input: { command, working_directory: '/project' },
  hook_event_name: 'preToolUse',
});

/** Cursor hook run: CURSOR_PROJECT_DIR points at the project, CLAUDE_PROJECT_DIR at a decoy with no config. */
function runCursor(root, opts = {}) {
  return runHook(CURSOR_HOOK, root, {
    ...opts,
    args: ['--format', 'cursor'],
    env: { CURSOR_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: makeProject(), ...(opts.env ?? {}) },
  });
}

test('cursor: a matching Shell command is denied with permission/user_message/agent_message', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: cursorPayload(MATCHING) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.permission, 'deny');
  assert.ok(out.agent_message.includes(`forge lease ${LEASE_NAME} --`), out.agent_message);
  assert.ok(out.agent_message.includes(MATCHING));
  assert.equal(typeof out.user_message, 'string');
  assert.ok(out.user_message.length > 0);
  assert.deepEqual(Object.keys(out).sort(), ['agent_message', 'permission', 'user_message']);
  assert.equal(r.stderr, '');
  assertDenyOnly(r);
});

test('cursor: the project dir comes from CURSOR_PROJECT_DIR, not CLAUDE_PROJECT_DIR', () => {
  // runCursor gives CLAUDE_PROJECT_DIR a config-less decoy; the deny above only
  // happens if the hook read the config under CURSOR_PROJECT_DIR.
  const root = makeProject(leaseConfig());
  const decoy = makeProject();
  const r = runHook(CURSOR_HOOK, decoy, {
    payload: cursorPayload(MATCHING),
    args: ['--format', 'cursor'],
    env: { CURSOR_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: decoy },
  });
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
});

test('cursor: without CURSOR_PROJECT_DIR the hook falls back to its cwd', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CURSOR_HOOK, root, {
    payload: cursorPayload(MATCHING),
    args: ['--format', 'cursor'],
    env: { CURSOR_PROJECT_DIR: '', CLAUDE_PROJECT_DIR: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
});

// Cursor treats exit 0 as "use my JSON output" and blocks on a missing/invalid one, and exit 2 as
// block. The only pass-through that approves nothing is any other exit code (fail-open): 1.
function assertCursorPassThrough(r, label = '') {
  assert.equal(r.status, 1, `${label} ${r.stderr}`);
  assert.equal(r.stdout, '', label);
  assertDenyOnly(r);
}

test('cursor: a non-matching Shell command passes through with exit 1, no stdout, no stderr', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: cursorPayload('ls -la') });
  assertCursorPassThrough(r);
  assert.equal(r.stderr, '');
});

test('cursor: a wrapped forge lease command passes through with exit 1', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: cursorPayload(`forge lease ${LEASE_NAME} -- ${MATCHING}`) });
  assertCursorPassThrough(r);
  assert.equal(r.stderr, '');
});

test('cursor: tools other than Shell pass through with exit 1', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: cursorPayload(MATCHING, 'Read') });
  assertCursorPassThrough(r);
  assert.equal(r.stderr, '');
});

test('cursor: fast path (no config at all) passes through with exit 1 and spawns nothing', () => {
  const root = makeProject();
  const r = runCursor(root, {
    payload: cursorPayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${path.join(root, 'no-such-forge')}"` },
  });
  assertCursorPassThrough(r);
  assert.equal(r.stderr, '');
});

test('cursor: fast path (leases without match) passes through with exit 1 and spawns nothing', () => {
  const root = makeProject({ leases: { [LEASE_NAME]: { waitMs: 5 } } });
  const r = runCursor(root, {
    payload: cursorPayload(MATCHING),
    env: { FORGE_HOOK_FORGE_CMD: `"${path.join(root, 'no-such-forge')}"` },
  });
  assertCursorPassThrough(r);
  assert.equal(r.stderr, '');
});

test('cursor: empty stdin passes through with exit 1', () => {
  const root = makeProject(leaseConfig());
  assertCursorPassThrough(runCursor(root, { raw: '' }));
});

test('cursor: errors exit 1 with no stdout (never allow, never exit 2) and one warning', () => {
  const root = makeProject(leaseConfig());
  for (const r of [
    runCursor(root, { raw: 'garbage' }),
    runCursor(root, { payload: { tool_name: 'Shell', tool_input: { command: 7 } } }),
    runCursor(root, {
      payload: cursorPayload(MATCHING),
      env: { FORGE_HOOK_FORGE_CMD: `"${path.join(root, 'no-such-forge')}"` },
    }),
  ]) {
    assertCursorPassThrough(r);
    assert.equal(warningLines(r).length, 1, r.stderr);
    assert.match(warningLines(r)[0], /^\[forge\] Warning: .+ — lease-guard allowing\.$/);
  }
});

test('cursor: a deny still exits 0 with the deny JSON', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: cursorPayload(MATCHING) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
  assertDenyOnly(r);
});

test('claude: pass-through paths still exit 0 (only Cursor uses exit 1)', () => {
  const root = makeProject(leaseConfig());
  for (const r of [
    runHook(CLAUDE_HOOK, root, { payload: claudePayload('ls -la') }),
    runHook(CLAUDE_HOOK, makeProject(), { payload: claudePayload(MATCHING) }),
    runHook(CLAUDE_HOOK, root, { raw: 'garbage' }),
  ]) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('cursor: a top-level `command` (beforeShellExecution shape) is accepted too', () => {
  const root = makeProject(leaseConfig());
  const r = runCursor(root, { payload: { command: MATCHING, cwd: '/project' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
});

test('the claude template, cursor template and .claude/hooks copy are byte-identical', () => {
  const copy = path.join(REPO_ROOT, '.claude', 'hooks', 'forge-lease-guard.mjs');
  const claude = fs.readFileSync(CLAUDE_HOOK);
  assert.ok(fs.existsSync(CURSOR_HOOK), `${CURSOR_HOOK} exists`);
  assert.ok(claude.equals(fs.readFileSync(CURSOR_HOOK)));
  assert.ok(claude.equals(fs.readFileSync(copy)));
});

// --- Hardening: NUL in the command, `--format=cursor`, spawn timeout --------------

function assertCleanWarning(r, expectedStatus) {
  assert.equal(r.status, expectedStatus, r.stderr);
  assert.equal(r.stdout, '');
  assertDenyOnly(r);
  assert.equal(warningLines(r).length, 1, r.stderr);
  assert.match(warningLines(r)[0], /^\[forge\] Warning: .+ — lease-guard allowing\.$/);
  assert.doesNotMatch(r.stderr, /\n\s+at |TypeError|ERR_INVALID_ARG_VALUE/, 'no stack trace');
}

test('a NUL byte in the command warns once and passes through in both modes (no uncaught throw)', () => {
  const root = makeProject(leaseConfig());
  const command = `${MATCHING}\u0000 --name x`;
  assertCleanWarning(runHook(CLAUDE_HOOK, root, { payload: claudePayload(command) }), 0);
  assertCleanWarning(runCursor(root, { payload: cursorPayload(command) }), 1);
});

test('cursor: --format=cursor is the same as --format cursor', () => {
  const root = makeProject(leaseConfig());
  const r = runHook(CURSOR_HOOK, root, {
    payload: cursorPayload(MATCHING),
    args: ['--format=cursor'],
    env: { CURSOR_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: makeProject() },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.permission, 'deny');
  assert.ok(out.agent_message.includes(`forge lease ${LEASE_NAME} --`));
  assertDenyOnly(r);

  const pass = runHook(CURSOR_HOOK, root, {
    payload: cursorPayload('ls -la'),
    args: ['--format=cursor'],
  });
  assert.equal(pass.status, 1, 'non-deny uses the Cursor pass-through exit code');
  assert.equal(pass.stdout, '');
});

test('a forge that outlives the spawn timeout warns once and passes through in both modes', async () => {
  const root = makeProject(leaseConfig());
  const slow = path.join(root, 'slow.mjs');
  const marker = path.join(root, 'forge-finished');
  fs.writeFileSync(
    slow,
    `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'done'), 3000);\n`,
    'utf8',
  );
  const env = {
    FORGE_HOOK_FORGE_CMD: `"${process.execPath}" "${slow}"`,
    FORGE_LEASE_GUARD_TIMEOUT_MS: '300',
  };
  for (const [r, status] of [
    [runHook(CLAUDE_HOOK, root, { payload: claudePayload(MATCHING), env }), 0],
    [runCursor(root, { payload: cursorPayload(MATCHING), env }), 1],
  ]) {
    assertCleanWarning(r, status);
    assert.match(r.stderr, /ETIMEDOUT|timed out/i, 'the warning names the timeout');
  }
  // The sleeping forge was killed at the timeout, not waited out.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(marker), false, 'forge was killed before it finished');
});

test('the spawn has a bounded default timeout of 10 seconds', () => {
  assert.match(fs.readFileSync(CLAUDE_HOOK, 'utf8'), /FORGE_LEASE_GUARD_TIMEOUT_MS[\s\S]{0,200}10000/);
});
