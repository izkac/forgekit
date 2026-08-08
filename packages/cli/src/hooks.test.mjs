import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHookCommands, commandBasename, isCommandReferenced } from './hooks.mjs';
import { checkHookWiring } from './doctor.mjs';
import { initProject, mergeHooksIntoSettings } from './init.mjs';

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-shared-'));
}

// --- collectHookCommands ---

test('collectHookCommands: walks nested arrays and objects, collects only string `command` values', () => {
  const out = new Set();
  collectHookCommands(
    {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo a' }] }],
      PreToolUse: [
        { matcher: 'x', hooks: [{ command: 'echo b' }, { command: 'echo c' }] },
      ],
    },
    out,
  );
  assert.deepEqual([...out].sort(), ['echo a', 'echo b', 'echo c']);
});

test('collectHookCommands: ignores non-string `command` values and missing keys', () => {
  const out = new Set();
  collectHookCommands(
    {
      SessionStart: [{ hooks: [{ command: 42 }, { command: null }, {}] }],
      UserPromptSubmit: undefined,
    },
    out,
  );
  assert.deepEqual([...out], []);
});

test('collectHookCommands: tolerates non-object, non-array input', () => {
  const out = new Set();
  collectHookCommands('not a tree', out);
  collectHookCommands(null, out);
  collectHookCommands(undefined, out);
  assert.deepEqual([...out], []);
});

// --- commandBasename ---

test('commandBasename: extracts the trailing script name from a quoted path', () => {
  assert.equal(
    commandBasename('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-model-hook.mjs"'),
    'forge-model-hook.mjs',
  );
});

test('commandBasename: handles Windows-style backslash paths', () => {
  assert.equal(
    commandBasename('node "C:\\proj\\.claude\\hooks\\forge-session-start.mjs"'),
    'forge-session-start.mjs',
  );
});

// --- isCommandReferenced: the path-boundary match ---

test('isCommandReferenced: matches the real hook command', () => {
  const commands = ['node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-session-start.mjs"'];
  assert.equal(isCommandReferenced('forge-session-start.mjs', commands), true);
});

test('isCommandReferenced: a wrapper script name does NOT mask the real hook (no bare substring match)', () => {
  const commands = ['node "${CLAUDE_PROJECT_DIR}/.claude/hooks/my-forge-session-start.mjs"'];
  assert.equal(
    isCommandReferenced('forge-session-start.mjs', commands),
    false,
    'my-forge-session-start.mjs must not count as a reference to forge-session-start.mjs',
  );
});

test('isCommandReferenced: no match among unrelated commands', () => {
  const commands = ['echo hi', 'node other-script.mjs'];
  assert.equal(isCommandReferenced('forge-session-start.mjs', commands), false);
});

test('isCommandReferenced: false for an empty basename, never throws on non-string entries', () => {
  assert.equal(isCommandReferenced('', ['anything']), false);
  assert.equal(isCommandReferenced('forge-x.mjs', [42, null, 'node forge-x.mjs']), true);
});

// --- Cross-surface agreement: doctor's checkHookWiring vs init's mergeHooksIntoSettings ---
//
// Both now share the same walker + predicate, but the reviewer asked for a
// test that pins the *decision*, not just the primitives: for a matrix of
// settings shapes, doctor's verdict on whether a hook file is wired must
// agree with whether init's merge considers the corresponding snippet group
// already-referenced (and therefore skips re-appending it).

function agreementCase(cwd, { settings, settingsLocal, hookName, snippetCommand }) {
  fs.mkdirSync(path.join(cwd, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'hooks', hookName), '// stub\n');
  if (settings !== undefined) {
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  if (settingsLocal !== undefined) {
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify(settingsLocal),
    );
  }

  const doctorSaysWired = checkHookWiring({ cwd }).surfaces
    .find((s) => s.surface === 'claude')
    ?.unwired.includes(hookName) === false;

  // "Already referenced" means the merge added nothing new for this event —
  // not that the resulting array is empty (it may start non-empty).
  const existingSessionStartLen = Array.isArray(settings?.hooks?.SessionStart)
    ? settings.hooks.SessionStart.length
    : 0;
  const snippet = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: snippetCommand }] }] } };
  const mergeResult = mergeHooksIntoSettings({
    settings: settings ?? {},
    snippet,
    localSettings: settingsLocal,
  });
  const mergedSessionStart = mergeResult.settings.hooks.SessionStart ?? [];
  const initSaysAlreadyReferenced = mergedSessionStart.length === existingSessionStartLen;

  return { doctorSaysWired, initSaysAlreadyReferenced };
}

test('agreement: nested-array wiring in settings.json', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    const snippetCommand = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookName}"`;
    const { doctorSaysWired, initSaysAlreadyReferenced } = agreementCase(cwd, {
      settings: { hooks: { SessionStart: [{ hooks: [{ command: snippetCommand }] }] } },
      hookName,
      snippetCommand,
    });
    assert.equal(doctorSaysWired, true);
    assert.equal(initSaysAlreadyReferenced, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('agreement: missing settings.json entirely -> both say unwired/not-yet-referenced', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    const snippetCommand = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookName}"`;
    const { doctorSaysWired, initSaysAlreadyReferenced } = agreementCase(cwd, {
      hookName,
      snippetCommand,
    });
    assert.equal(doctorSaysWired, false);
    assert.equal(initSaysAlreadyReferenced, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('agreement: wired only via settings.local.json (the F74 follow-up bug) -> both say wired', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    const snippetCommand = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookName}"`;
    const { doctorSaysWired, initSaysAlreadyReferenced } = agreementCase(cwd, {
      settingsLocal: { hooks: { SessionStart: [{ hooks: [{ command: snippetCommand }] }] } },
      hookName,
      snippetCommand,
    });
    assert.equal(doctorSaysWired, true);
    assert.equal(
      initSaysAlreadyReferenced,
      true,
      'init must treat settings.local.json wiring as already-referenced too',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('agreement: matcher-less group, non-string command siblings present -> both say unwired', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    const snippetCommand = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookName}"`;
    const { doctorSaysWired, initSaysAlreadyReferenced } = agreementCase(cwd, {
      settings: { hooks: { SessionStart: [{ hooks: [{ command: 42 }, { notCommand: 'x' }] }] } },
      hookName,
      snippetCommand,
    });
    assert.equal(doctorSaysWired, false);
    assert.equal(initSaysAlreadyReferenced, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('agreement: a wrapper-named hook file must not make either surface believe the real hook is wired', () => {
  const cwd = makeTempProject();
  try {
    const hookName = 'forge-session-start.mjs';
    const wrapperCommand = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/my-${hookName}"`;
    const { doctorSaysWired, initSaysAlreadyReferenced } = agreementCase(cwd, {
      settings: { hooks: { SessionStart: [{ hooks: [{ command: wrapperCommand }] }] } },
      hookName,
      snippetCommand: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${hookName}"`,
    });
    assert.equal(doctorSaysWired, false);
    assert.equal(initSaysAlreadyReferenced, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('end-to-end agreement: forge init from an unwired state produces a project forge doctor calls wired, with matching hook counts', () => {
  const cwd = makeTempProject();
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    const result = checkHookWiring({ cwd });
    assert.equal(result.ok, true);
    const claude = result.surfaces.find((s) => s.surface === 'claude');
    assert.deepEqual(claude.unwired, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
