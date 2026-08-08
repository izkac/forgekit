/**
 * `templates/project/claude/hooks/forge-test-guard.mjs` — the PreToolUse
 * hook that enforces the test-tamper guard for Edit/Write/NotebookEdit tool
 * calls, per specs/changes/tdd-evidence-guard/specs/test-guard/spec.md.
 *
 * The hook is a thin shell around `forge guard check --file <path> --json`
 * (guard-cli.test.mjs already proves that command's decision table
 * end-to-end); these tests prove the hook's own job: extracting the right
 * path per tool, mapping guard's exit codes to a PreToolUse decision, and
 * failing open — loudly — on every internal error.
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
const TEMPLATE_HOOK = path.join(resolveTemplatesRoot(), 'claude', 'hooks', 'forge-test-guard.mjs');
const REPO_HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'forge-test-guard.mjs');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A scratch project: git repo with a committed baseline test file (guarded)
 * and a committed plain file (unguarded), a Forge session at the given
 * phase/baseCommit, and `.forge/active.json` pointing at it. Mirrors
 * guard-cli.test.mjs's fixture so the hook is exercised against the same
 * shapes its wrapped command already proves.
 */
function makeProject({
  phase = 'implement',
  baseCommit: baseCommitOverride,
  rootPrefix = 'test-guard-hook-',
} = {}) {
  const root = tmp(rootPrefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'foo.test.mjs'), 'baseline\n', 'utf8');
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'plain.mjs'), 'code\n', 'utf8');
  fs.writeFileSync(path.join(root, 'notebook.test.ipynb'), '{}\n', 'utf8');
  // A guarded baseline file whose name contains a space — real Claude Code
  // checkouts routinely sit under paths with spaces (e.g. "My Projects/").
  fs.writeFileSync(path.join(root, 'packages', 'cli', 'src', 'my code.test.mjs'), 'baseline\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');

  const sessionId = 's1';
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = {
    id: sessionId,
    slug: 'fixture',
    phase,
    ...(baseCommitOverride === undefined ? { baseCommit } : baseCommitOverride === null ? {} : { baseCommit: baseCommitOverride }),
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.forge', 'active.json'), `${JSON.stringify({ sessionId })}\n`, 'utf8');
  return { root, sessionDir, sessionId, baseCommit };
}

/**
 * @param {string} root cwd for the hook process (== CLAUDE_PROJECT_DIR)
 * @param {unknown} payload PreToolUse payload object, or a raw string when `raw` given
 * @param {{ raw?: string, env?: Record<string, string> }} [opts]
 */
function runHook(root, payload, opts = {}) {
  const input = opts.raw !== undefined ? opts.raw : JSON.stringify(payload);
  return spawnSync(process.execPath, [TEMPLATE_HOOK], {
    input,
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...(opts.env ?? {}) },
  });
}

function editPayload(filePath) {
  return { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } };
}

function writePayload(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } };
}

function notebookPayload(notebookPath) {
  return { tool_name: 'NotebookEdit', tool_input: { notebook_path: notebookPath, new_source: 'x' } };
}

function multiEditPayload(filePath) {
  return {
    tool_name: 'MultiEdit',
    tool_input: { file_path: filePath, edits: [{ old_string: 'a', new_string: 'b' }] },
  };
}

test('denies an Edit on a guarded baseline test during implement, naming the rule and the escape', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, editPayload('packages/cli/src/foo.test.mjs'));
  assert.equal(r.status, 0, r.stderr); // hook itself always exits 0; the decision is in stdout JSON
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /\*\*\/\*\.test\.\*/, 'names the matched glob');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /forge test-allow packages\/cli\/src\/foo\.test\.mjs --reason/,
    'names the escape hatch',
  );
});

test('deny persists when the session has moved on to verify', () => {
  const { root } = makeProject({ phase: 'verify' });
  const r = runHook(root, writePayload('packages/cli/src/foo.test.mjs'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('allows a Write on an unguarded file silently: no stdout, exit 0', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, writePayload('packages/cli/src/plain.mjs'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'allow is silent — no hook JSON at all');
});

test('extracts notebook_path (not file_path) for NotebookEdit and denies a guarded notebook test', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, notebookPayload('notebook.test.ipynb'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(
    out.hookSpecificOutput.permissionDecision,
    'deny',
    'a NotebookEdit payload has no file_path field; a hook that mistakenly read tool_input.file_path would find undefined and fail open (allow), not deny',
  );
});

test('fails open with a stderr warning when forge guard check hits an internal error (exit 1)', () => {
  // baseCommit that cannot resolve -> `git ls-tree` fails -> guard-cli exits 1.
  const { root } = makeProject({ phase: 'implement', baseCommit: 'not-a-real-commit-sha' });
  const r = runHook(root, editPayload('packages/cli/src/foo.test.mjs'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'no deny JSON is emitted on an internal error');
  assert.match(r.stderr, /\[forge\] Warning:/);
});

test('fails open with a stderr warning when the forge binary cannot be found', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, editPayload('packages/cli/src/foo.test.mjs'), { env: { PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /\[forge\] Warning:/);
});

test('fails open with a stderr warning on malformed stdin JSON', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, null, { raw: '{ not json' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /\[forge\] Warning:/);
});

test('allows silently (no warning) for tool calls other than Edit/Write/NotebookEdit', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, { tool_name: 'Bash', tool_input: { command: 'rm packages/cli/src/foo.test.mjs' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '', 'an irrelevant tool never needs a warning');
});

test('allows with a stderr warning when tool_input carries no usable path', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, { tool_name: 'Write', tool_input: {} });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /\[forge\] Warning:/);
});

test('empty stdin allows silently', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, null, { raw: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('denies an Edit on a guarded baseline test whose path contains a space', () => {
  // Guards against a `spawnSync(..., { shell: true })` bug: joining argv into
  // an unquoted shell command string splits this path at the space, so
  // guard-cli sees `--file src my` and classifies the bogus first segment
  // instead — silently allowing the real edit through with no warning.
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, editPayload('packages/cli/src/my code.test.mjs'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /\*\*\/\*\.test\.\*/, 'names the matched glob');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /forge test-allow packages\/cli\/src\/my code\.test\.mjs --reason/,
    'names the escape hatch with the real (unsplit) path',
  );
});

test('denies an Edit using an absolute payload path under a directory containing a space (production shape)', () => {
  // Claude Code always sends absolute file_path values. Any checkout living
  // under a directory with a space in it (very common) hits the same
  // shell-splitting bug as above, but via the *root* rather than the
  // filename — this pins that production path shape directly.
  const { root } = makeProject({ phase: 'implement', rootPrefix: 'test guard hook-' });
  const absPath = path.join(root, 'packages', 'cli', 'src', 'foo.test.mjs');
  const r = runHook(root, editPayload(absPath));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /forge test-allow packages\/cli\/src\/foo\.test\.mjs --reason/,
  );
});

test('never executes shell metacharacters embedded in file_path (command injection)', () => {
  const { root } = makeProject({ phase: 'implement' });
  const markerDir = tmp('test-guard-pwn-');
  const marker = path.join(markerDir, 'PWNED');
  const filePath = `packages/cli/src/foo.test.mjs; touch ${marker} #`;
  const r = runHook(root, editPayload(filePath));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marker), 'file_path must never reach a shell as a command');
  if (r.stdout) {
    const out = JSON.parse(r.stdout);
    assert.ok(
      ['allow', 'deny'].includes(out.hookSpecificOutput?.permissionDecision),
      'still a well-formed hook decision, not garbage',
    );
  }
});

test('denies a MultiEdit on a guarded baseline test', () => {
  const { root } = makeProject({ phase: 'implement' });
  const r = runHook(root, multiEditPayload('packages/cli/src/foo.test.mjs'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /forge test-allow packages\/cli\/src\/foo\.test\.mjs --reason/,
  );
});

test('template and repo copies of forge-test-guard.mjs are byte-identical', () => {
  assert.ok(fs.existsSync(TEMPLATE_HOOK), `missing ${TEMPLATE_HOOK}`);
  assert.ok(fs.existsSync(REPO_HOOK), `missing ${REPO_HOOK}`);
  assert.ok(
    fs.readFileSync(TEMPLATE_HOOK).equals(fs.readFileSync(REPO_HOOK)),
    'templates/project/claude/hooks/forge-test-guard.mjs and .claude/hooks/forge-test-guard.mjs must be in sync',
  );
});
