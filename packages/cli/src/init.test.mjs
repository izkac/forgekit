import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  initAgentIds,
  initProject,
  mergeHooksIntoSettings,
  rememberedAgents,
  resolveInitPlanEngine,
  resolveTemplatesRoot,
} from './init.mjs';
import { AGENT_IDS, FORGEKIT_STAMP, installSkillsToAgents } from './install.mjs';
import { loadProjectConfig, saveUserConfig } from './config.mjs';
import { DEFAULT_SPECS_DIR, writeProjectPlanConfig } from './plan-engine.mjs';
import { DEFAULT_ADR_DIR, decisionsDocFor, disableProjectAdr, writeProjectAdrConfig } from './adr.mjs';

test('init parseArgs accepts the expanded environment shorthands', () => {
  const opts = parseArgs(['--cursor', '--copilot', '--gemini', '--windsurf', '--opencode']);
  assert.deepEqual(opts.agents, ['cursor', 'copilot', 'gemini', 'windsurf', 'opencode']);
});

test('rememberedAgents unions install config, installed skills, and project wiring', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-proj-'));
  try {
    // Chosen during `forgekit install` (saved to user config).
    saveUserConfig({ agents: ['claude', 'gemini'] }, home);
    // Independent dest so sharing .agents aliases are not pulled in.
    installSkillsToAgents(['forge'], ['windsurf'], { home, force: true });
    // Project already wired for cursor.
    fs.mkdirSync(path.join(cwd, '.cursor', 'commands'), { recursive: true });

    const remembered = rememberedAgents(cwd, home);
    assert.ok(remembered.has('claude'), 'from install config');
    assert.ok(remembered.has('gemini'), 'from install config');
    assert.ok(remembered.has('windsurf'), 'from installed skill dir');
    assert.ok(remembered.has('cursor'), 'from project wiring marker');
    assert.ok(!remembered.has('codex'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('re-running init refreshes stale managed rule files in place', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-refresh-'));
  try {
    initProject(['claude'], { cwd, adr: false, planEngine: null });
    const rule = path.join(cwd, '.claude', 'rules', 'forge.md');
    // Simulate an older install with a stale reference.
    fs.writeFileSync(rule, 'Full workflow: forgekit `docs/forge.md`\n', 'utf8');

    const report = initProject(['claude'], { cwd, adr: false, planEngine: null });
    const updated = fs.readFileSync(rule, 'utf8');
    assert.ok(!updated.includes('forgekit `docs/forge.md`'), 'stale ref replaced');
    assert.ok(updated.includes('~/.claude/skills/forge/docs/forge.md'), 'points to global skill doc');
    assert.ok(
      report.files.some((f) => f.file.includes('forge.md') && f.status === 'updated'),
      'reports the refresh as updated',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('thin-rule templates are engine-neutral (no hardcoded OpenSpec-only flow)', () => {
  const root = resolveTemplatesRoot();
  for (const rel of ['claude/rules/forge.md', 'cursor/rules/forge.mdc', 'codex/rules/forge.md']) {
    const body = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    assert.ok(!/Forge = OpenSpec/.test(body), `${rel} still says "Forge = OpenSpec"`);
    assert.ok(body.includes('forge change new'), `${rel} missing built-in specs command`);
    assert.ok(body.includes('/opsx:propose'), `${rel} missing OpenSpec command`);
  }
});

test('thin-rule templates are opt-in (no auto-triage default)', () => {
  const root = resolveTemplatesRoot();
  for (const rel of ['claude/rules/forge.md', 'cursor/rules/forge.mdc', 'codex/rules/forge.md']) {
    const body = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    assert.ok(
      !/triage before implementation/i.test(body),
      `${rel} still auto-triages every request`,
    );
    assert.ok(/use Forge/i.test(body), `${rel} missing natural-language invoke`);
    assert.ok(body.includes('/forge'), `${rel} missing /forge invoke`);
  }
});

test('Forge skill is opt-in and still triages after invoke', () => {
  const skill = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/forge/SKILL.md'),
    'utf8',
  );
  assert.match(skill, /disable-model-invocation:\s*true/);
  assert.match(skill, /Triage \(after invoke\)/);
  assert.ok(!/Use when building features, fixing non-trivial bugs/.test(skill));
});

// /forge over an already-proposed change fell through to inline implementation
// (no session, no subagents) because the command never routed it. The command
// itself must route to the apply flow — not rely on the skill body alone.
test('/forge command routes existing changes to the apply flow', () => {
  const root = resolveTemplatesRoot();
  for (const rel of ['claude/commands/forge.md', 'cursor/commands/forge.md']) {
    const body = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    assert.match(body, /already-proposed\s+change/, `${rel} missing existing-change routing`);
    assert.match(body, /\/forge:apply/, `${rel} does not route to the apply flow`);
    assert.match(body, /forge phase implement/, `${rel} missing implement phase command`);
    assert.match(
      body,
      /Never implement an already-proposed change inline/,
      `${rel} missing inline-implementation ban`,
    );
  }
});

test('claude init ships the model-policy hook and registers it in the snippet', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-model-hook-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    const hook = path.join(cwd, '.claude', 'hooks', 'forge-model-hook.mjs');
    assert.ok(fs.existsSync(hook), 'hook body copied into the project');
    assert.match(fs.readFileSync(hook, 'utf8'), /forge['"],\s*\['enforce-model'\]/);

    const snippet = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
    const pre = snippet.hooks.PreToolUse[0];
    assert.equal(pre.matcher, 'Agent|Task');
    assert.match(pre.hooks[0].command, /forge-model-hook\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('claude init ships the test-guard hook and registers it in the snippet', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-test-guard-hook-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    const hook = path.join(cwd, '.claude', 'hooks', 'forge-test-guard.mjs');
    assert.ok(fs.existsSync(hook), 'hook body copied into the project');
    assert.match(fs.readFileSync(hook, 'utf8'), /forge['"],\s*\['guard',\s*'check'/);

    const snippet = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
    const entries = snippet.hooks.PreToolUse;
    const testGuard = entries.find((entry) => entry.matcher === 'Edit|Write|NotebookEdit|MultiEdit');
    assert.ok(testGuard, 'a PreToolUse entry matches Edit|Write|NotebookEdit|MultiEdit');
    assert.match(testGuard.hooks[0].command, /forge-test-guard\.mjs/);
    // The existing model-policy entry must still be present, unreplaced.
    assert.ok(entries.some((entry) => entry.matcher === 'Agent|Task'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('test-guard PreToolUse matcher includes MultiEdit (it carries file_path like Edit)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-test-guard-multiedit-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    const snippet = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
    const entries = snippet.hooks.PreToolUse;
    const testGuard = entries.find((entry) => entry.hooks[0].command.includes('forge-test-guard.mjs'));
    assert.ok(testGuard, 'the test-guard PreToolUse entry exists');
    assert.ok(
      testGuard.matcher.split('|').includes('MultiEdit'),
      `matcher "${testGuard.matcher}" must include MultiEdit`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject wires templated envs and marks the rest skill-only', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-'));
  try {
    const report = initProject(['cursor', 'copilot', 'gemini'], {
      cwd,
      force: true,
      adr: false,
      planEngine: null,
    });
    assert.ok(report.files.some((f) => f.file.includes('.cursor')));
    assert.deepEqual(report.skillOnly, ['copilot', 'gemini']);
    assert.ok(!fs.existsSync(path.join(cwd, '.copilot')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cursor init creates .cursor/hooks.json with forge sessionStart', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-cursor-hooks-'));
  try {
    initProject(['cursor'], { cwd, force: true, adr: false, planEngine: null });
    const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
    assert.ok(fs.existsSync(hooksPath), 'hooks.json created');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooks.version, 1);
    const cmds = (hooks.hooks?.sessionStart ?? []).map((h) => h.command);
    assert.ok(
      cmds.some((c) => String(c).includes('forge-session-start')),
      'sessionStart runs forge-session-start',
    );
    assert.ok(fs.existsSync(path.join(cwd, '.cursor', 'forge-hooks.snippet.json')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cursor init merges forge sessionStart without dropping other hooks', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-cursor-merge-'));
  try {
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.cursor', 'hooks.json'),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            stop: [{ command: 'echo stop-hook' }],
            sessionStart: [{ command: 'echo other-start' }],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    initProject(['cursor'], { cwd, force: true, adr: false, planEngine: null });
    const hooks = JSON.parse(fs.readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.stop[0].command, 'echo stop-hook');
    const starts = hooks.hooks.sessionStart.map((h) => h.command);
    assert.ok(starts.includes('echo other-start'));
    assert.ok(starts.some((c) => String(c).includes('forge-session-start')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Task 6.1 / F74: mergeHooksIntoSettings — pure structural merge ---

/**
 * The real snippet `forge init` generates, so expected counts/shapes are
 * derived from the fixture in code rather than typed into assertions.
 */
function realSnippet() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-snippet-src-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    return JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function totalGroupCount(hooks) {
  return Object.values(hooks).reduce((sum, groups) => sum + groups.length, 0);
}

test('mergeHooksIntoSettings: empty settings gets every snippet group appended', () => {
  const snippet = realSnippet();
  const result = mergeHooksIntoSettings({ settings: {}, snippet });

  assert.equal(result.ok, true);
  const merged = result.settings;
  const expectedGroups = totalGroupCount(snippet.hooks);
  assert.ok(expectedGroups > 0, 'fixture sanity: snippet actually has hook groups');
  assert.equal(totalGroupCount(merged.hooks), expectedGroups);
  for (const key of Object.keys(snippet.hooks)) {
    assert.equal(merged.hooks[key].length, snippet.hooks[key].length, `event ${key} fully appended`);
  }
});

test('mergeHooksIntoSettings: unrelated top-level keys are preserved untouched', () => {
  const snippet = realSnippet();
  const settings = { permissions: { allow: ['Bash(ls:*)'] }, env: { FOO: 'bar' } };

  const merged = mergeHooksIntoSettings({ settings, snippet }).settings;

  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.env, settings.env);
});

test('mergeHooksIntoSettings: a user-defined hook on the same event survives, snippet groups append alongside it', () => {
  const snippet = realSnippet();
  const userGroup = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node scripts/user-lint.mjs' }],
  };
  const settings = { hooks: { PreToolUse: [userGroup] } };

  const merged = mergeHooksIntoSettings({ settings, snippet }).settings;

  const preToolUse = merged.hooks.PreToolUse;
  assert.deepEqual(preToolUse[0], userGroup, 'user group preserved verbatim, in place');
  assert.equal(
    preToolUse.length,
    1 + snippet.hooks.PreToolUse.length,
    'snippet groups appended alongside the user group',
  );
});

test('mergeHooksIntoSettings: only the still-missing groups are appended when some forge hooks already exist', () => {
  const snippet = realSnippet();
  // Discriminating fixture: SessionStart is pre-wired (the "winner" that must
  // NOT grow); every other event is untouched (the "losers" that must fill in
  // to exactly the snippet's own counts). If group-level dedup were broken,
  // either SessionStart would double or another event would stay empty.
  const settings = {
    hooks: { SessionStart: JSON.parse(JSON.stringify(snippet.hooks.SessionStart)) },
  };

  const merged = mergeHooksIntoSettings({ settings, snippet }).settings;

  assert.equal(
    merged.hooks.SessionStart.length,
    snippet.hooks.SessionStart.length,
    'already-wired event is not duplicated',
  );
  for (const key of Object.keys(snippet.hooks)) {
    if (key === 'SessionStart') continue;
    assert.equal(
      merged.hooks[key].length,
      snippet.hooks[key].length,
      `missing event ${key} fully appended`,
    );
  }
});

test('mergeHooksIntoSettings: a partially-wired group is topped up command-by-command, not duplicated whole', () => {
  // Synthetic two-command group: the real UserPromptSubmit snippet now ships
  // a single command (prompt hook). Merge still has to top up leaf-by-leaf.
  const wiredLeaf = {
    type: 'command',
    command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-prompt-hook.mjs"',
  };
  const missingLeaf = {
    type: 'command',
    command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-other-hook.mjs"',
  };
  const snippet = {
    hooks: { UserPromptSubmit: [{ hooks: [wiredLeaf, missingLeaf] }] },
  };
  assert.notEqual(wiredLeaf.command, missingLeaf.command, 'fixture sanity: two distinct commands');

  const settings = {
    hooks: { UserPromptSubmit: [{ hooks: [JSON.parse(JSON.stringify(wiredLeaf))] }] },
  };

  const merged = mergeHooksIntoSettings({ settings, snippet }).settings;

  const allCommands = [];
  for (const group of merged.hooks.UserPromptSubmit) {
    for (const leaf of group.hooks) allCommands.push(leaf.command);
  }
  assert.deepEqual(
    allCommands.filter((c) => c === wiredLeaf.command),
    [wiredLeaf.command],
    'the already-wired command appears exactly once (not duplicated)',
  );
  assert.deepEqual(
    allCommands.filter((c) => c === missingLeaf.command),
    [missingLeaf.command],
    'the missing command was added exactly once',
  );
});

test('mergeHooksIntoSettings: refuses a non-object `hooks` value instead of silently discarding it', () => {
  const snippet = realSnippet();
  const settings = { hooks: 'not-an-object' };

  const result = mergeHooksIntoSettings({ settings, snippet });

  assert.equal(result.ok, false);
  assert.deepEqual(result.settings, settings, 'settings returned unchanged, not overwritten');
  assert.match(result.error, /hooks/i);
});

test('mergeHooksIntoSettings: a non-array event value is left untouched and named in warnings, not silently treated as merged', () => {
  const snippet = realSnippet();
  const settings = { hooks: { SessionStart: { notAnArray: true } } };

  const result = mergeHooksIntoSettings({ settings, snippet });

  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.hooks.SessionStart, { notAnArray: true }, 'left untouched');
  assert.ok(
    result.warnings.some((w) => w.includes('SessionStart')),
    `expected a warning naming SessionStart, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('mergeHooksIntoSettings: a hook already wired only via settings.local.json is not re-appended (F74 follow-up)', () => {
  const snippet = realSnippet();
  const sessionStartLeaf = snippet.hooks.SessionStart[0].hooks[0];
  const localSettings = {
    hooks: { SessionStart: [{ hooks: [JSON.parse(JSON.stringify(sessionStartLeaf))] }] },
  };

  const result = mergeHooksIntoSettings({ settings: {}, snippet, localSettings });

  assert.equal(result.ok, true);
  assert.equal(
    (result.settings.hooks.SessionStart ?? []).length,
    0,
    'settings.json stays untouched for an event fully wired via settings.local.json alone',
  );
});

test('mergeHooksIntoSettings: a wrapper-named command in settings.json does not mask the real hook', () => {
  const snippet = realSnippet();
  const sessionStartLeaf = snippet.hooks.SessionStart[0].hooks[0];
  const wrapperCommand = sessionStartLeaf.command.replace('forge-session-start.mjs', 'my-forge-session-start.mjs');
  const settings = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: wrapperCommand }] }] },
  };

  const merged = mergeHooksIntoSettings({ settings, snippet }).settings;

  assert.equal(
    merged.hooks.SessionStart.length,
    2,
    'the wrapper entry stays, and the real hook is appended alongside it',
  );
});

test('mergeHooksIntoSettings: merging twice is structurally idempotent', () => {
  const snippet = realSnippet();
  const once = mergeHooksIntoSettings({ settings: {}, snippet });
  assert.equal(once.ok, true);
  const twice = mergeHooksIntoSettings({ settings: once.settings, snippet });
  assert.deepEqual(twice, once);
});

test('mergeHooksIntoSettings: never mutates its inputs', () => {
  const snippet = realSnippet();
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  };
  const localSettings = { hooks: { SessionStart: [{ hooks: [{ command: 'echo local' }] }] } };
  const settingsBefore = JSON.parse(JSON.stringify(settings));
  const snippetBefore = JSON.parse(JSON.stringify(snippet));
  const localSettingsBefore = JSON.parse(JSON.stringify(localSettings));

  mergeHooksIntoSettings({ settings, snippet, localSettings });

  assert.deepEqual(settings, settingsBefore, 'settings input unchanged');
  assert.deepEqual(snippet, snippetBefore, 'snippet input unchanged');
  assert.deepEqual(localSettings, localSettingsBefore, 'localSettings input unchanged');
});

// --- Task 6.1: `forge init` wires the merge into .claude/settings.json ---

test('initProject: fresh project ends up with settings.json created and fully merged', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-settings-merge-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), 'settings.json created');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const snippet = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
    for (const key of Object.keys(snippet.hooks)) {
      assert.equal(settings.hooks[key].length, snippet.hooks[key].length, `event ${key} wired`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject: an existing user hook in settings.json survives init verbatim', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-settings-user-hook-'));
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    const userGroup = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node scripts/user-lint.mjs' }],
    };
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: { PreToolUse: [userGroup] } }, null, 2)}\n`,
    );

    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PreToolUse[0], userGroup);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject: reproduction — a project wired only via settings.local.json gets zero new registrations, not doubled ones', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-settings-local-only-'));
  try {
    // Reproduce exactly: wire every hook via settings.local.json alone,
    // settings.json absent. Before the fix, `forge init` was blind to the
    // local file and would append every snippet group again.
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: 'specs' });
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const settingsLocalPath = path.join(cwd, '.claude', 'settings.local.json');
    const originalSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    fs.renameSync(settingsPath, settingsLocalPath);

    // Confirm the reproduction's precondition independently of our own fix:
    // doctor already considers this wired via settings.local.json alone
    // (that half of checkHookWiring predates this task).
    const before = runForge(['doctor'], cwd);
    assert.equal(before.status, 0, `expected settings.local.json alone to satisfy doctor: ${before.stdout}`);

    const originalTotalCommands = Object.values(originalSettings.hooks).reduce(
      (sum, groups) => sum + groups.reduce((n, g) => n + g.hooks.length, 0),
      0,
    );
    assert.ok(originalTotalCommands > 0, 'fixture sanity: the snippet actually registers hooks');

    initProject(['claude'], { cwd, force: true, adr: false, planEngine: 'specs' });

    assert.equal(fs.existsSync(settingsPath), true, 'settings.json was (re)created');
    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const newTotalCommands = Object.values(settingsAfter.hooks ?? {}).reduce(
      (sum, groups) => sum + groups.reduce((n, g) => n + g.hooks.length, 0),
      0,
    );
    assert.equal(
      newTotalCommands,
      0,
      `settings.json must gain zero registrations when everything is already wired via settings.local.json, got ${newTotalCommands}`,
    );

    const after = runForge(['doctor'], cwd);
    assert.equal(after.status, 0, `doctor still green afterward: ${after.stdout}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject: running init twice on the same project is structurally idempotent', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-settings-idempotent-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const first = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    const second = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject: malformed settings.json is left byte-identical and reported as unmerged', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-settings-malformed-'));
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const malformed = '{ this is not valid json';
    fs.writeFileSync(settingsPath, malformed);

    const report = initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformed, 'settings.json left untouched');
    assert.equal(report.claudeHooks.merged, false);
    assert.match(String(report.claudeHooks.error ?? ''), /json/i);
    assert.ok(
      report.claudeHooks.snippet.includes('forge-hooks.snippet.json'),
      'report names the snippet path for the manual merge',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Task 6.1: end-to-end via the real `forge` binary ---

const FORGE_BIN = fileURLToPath(new URL('../bin/forge.mjs', import.meta.url));

function runForge(args, cwd) {
  return spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8' });
}

test('end-to-end: a fresh `forge init` leaves `forge doctor` green', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-e2e-init-doctor-'));
  try {
    const init = runForge(['init', '--claude', '--force', '--no-openspec'], cwd);
    assert.equal(init.status, 0, `forge init failed: ${init.stderr}`);
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'settings.json')));

    const doctor = runForge(['doctor'], cwd);
    assert.equal(doctor.status, 0, `forge doctor failed: ${doctor.stdout}\n${doctor.stderr}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- fix-init-preserves-config: resolveInitPlanEngine honors recorded plan.engine ---

test('resolveInitPlanEngine: a flagless re-init keeps a recorded specs project (engine + dir)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-specs-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-specs-home-'));
  try {
    // Project already recorded specs — this is the settled decision.
    writeProjectPlanConfig(cwd, { engine: 'specs', dir: 'specs' });
    // Machine default disagrees, so honoring it (the bug) would flip the engine.
    saveUserConfig({ plan: { engine: 'openspec' } }, home);

    const engine = await resolveInitPlanEngine({
      cwd,
      home,
      openspec: null, // no --openspec / --no-openspec flag
      isTTY: false, // reproduced in a non-TTY agent/CI run
    });
    assert.equal(engine, 'specs', 'recorded plan.engine wins over the user default');

    // Drive it through the same write path `forge init` uses, to catch the
    // reproduced bug: a wrong engine here made writeProjectPlanConfig replace
    // the whole `plan` block, dropping `dir` entirely.
    initProject(['codex'], { cwd, force: true, adr: false, planEngine: engine, planDir: null });
    const config = loadProjectConfig(cwd);
    assert.equal(config.plan.engine, 'specs');
    assert.equal(config.plan.dir, 'specs', 'recorded plan.dir survives the re-init');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: explicit flags still outrank a recorded engine', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-flag-override-'));
  try {
    writeProjectPlanConfig(cwd, { engine: 'specs', dir: 'specs' });
    const toOpenspec = await resolveInitPlanEngine({
      cwd,
      openspec: true,
      isTTY: false,
    });
    assert.equal(toOpenspec, 'openspec', '--openspec still converts a recorded-specs project');

    writeProjectPlanConfig(cwd, { engine: 'openspec' });
    const toSpecs = await resolveInitPlanEngine({
      cwd,
      openspec: false,
      isTTY: false,
    });
    assert.equal(toSpecs, 'specs', '--no-openspec still forces specs on a recorded-openspec project');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInitPlanEngine: a first-time init with no recorded config is unchanged', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-first-run-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-first-run-home-'));
  try {
    assert.equal(loadProjectConfig(cwd).plan, undefined, 'fixture has no recorded plan yet');
    saveUserConfig({ plan: { engine: 'openspec' } }, home);

    const engine = await resolveInitPlanEngine({
      cwd,
      home,
      openspec: null,
      isTTY: false,
    });
    assert.equal(engine, 'openspec', 'falls back to the user default exactly as today');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- fix-init-preserves-config task 1.5: a flagless re-init preserves a
// recorded custom plan.dir. The fix lives inline in main() (init.mjs), not
// in an exported function, so these drive it through the real `forge init`
// subprocess — the same write path a user or agent actually hits.

test('forge init: a flagless re-init preserves a recorded custom plan.dir', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-dir-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-dir-home-'));
  try {
    // Project already recorded specs with a non-default root.
    writeProjectPlanConfig(cwd, { engine: 'specs', dir: 'docs/specs' });
    // Machine default disagrees, so honoring it (the bug) would flip the engine
    // too; group 1 already fixed that half — this test is about `dir`.
    saveUserConfig({ plan: { engine: 'openspec' } }, home);

    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--claude', '--force'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, `forge init failed: ${result.stderr}`);

    const config = loadProjectConfig(cwd);
    assert.equal(config.plan.engine, 'specs');
    assert.equal(config.plan.dir, 'docs/specs', 'recorded custom plan.dir survives the re-init');
    assert.ok(
      fs.existsSync(path.join(cwd, 'docs', 'specs', 'README.md')),
      'scaffold actually lands at the recorded dir, not the default',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('forge init: a first-run project with no recorded plan.dir still gets the default (nothing invented)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-first-run-dir-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-first-run-dir-home-'));
  try {
    assert.equal(loadProjectConfig(cwd).plan, undefined, 'fixture has no recorded plan yet');

    // os.homedir() reads USERPROFILE on Windows, HOME elsewhere — set both so
    // the machine's real ~/.forgekit/config.json cannot leak into the fixture.
    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--claude', '--force'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, `forge init failed: ${result.stderr}`);

    const config = loadProjectConfig(cwd);
    assert.equal(config.plan.engine, 'specs');
    assert.equal(
      config.plan.dir,
      DEFAULT_SPECS_DIR,
      'absent recorded plan.dir falls through to the default, not invented',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- fix-init-preserves-config task 2.1/2.2: a flagless re-init preserves a
// recorded adr.enabled. The block lives inline in main() (init.mjs), so these
// drive it through the real `forge init` subprocess, mirroring 1.5.

test('forge init: a flagless re-init keeps a recorded adr.enabled:false project (no scaffold)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-adr-off-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-adr-off-home-'));
  try {
    // Project already recorded ADRs off — the settled decision.
    disableProjectAdr(cwd);
    // Machine default disagrees: honoring it (the bug) would flip ADRs on.
    saveUserConfig({ adr: { enabled: true } }, home);

    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--claude', '--force'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, `forge init failed: ${result.stderr}`);

    const config = loadProjectConfig(cwd);
    assert.equal(config.adr.enabled, false, 'recorded adr.enabled:false survives the re-init');
    assert.ok(
      !fs.existsSync(path.join(cwd, ...DEFAULT_ADR_DIR.split('/'), 'README.md')),
      'no ADR dir README scaffolded',
    );
    assert.ok(
      !fs.existsSync(path.join(cwd, ...decisionsDocFor(DEFAULT_ADR_DIR).split('/'))),
      'no decisions doc scaffolded',
    );
    assert.ok(
      !fs.existsSync(path.join(cwd, 'scripts', 'hooks', 'check-pending-adrs.sh')),
      'no ADR hook script scaffolded',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('forge init: a flagless re-init keeps a recorded adr.enabled:true project even when the user default disables ADRs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-adr-on-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-recorded-adr-on-home-'));
  try {
    // Project already recorded ADRs on — the settled decision.
    writeProjectAdrConfig(cwd, { adr: { enabled: true } });
    // Machine default disagrees: honoring it (the bug) would flip ADRs off
    // and would actively erase the recorded `true` in .forge/config.json.
    saveUserConfig({ adr: { enabled: false } }, home);

    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--claude', '--force'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, `forge init failed: ${result.stderr}`);

    const config = loadProjectConfig(cwd);
    assert.equal(config.adr.enabled, true, 'recorded adr.enabled:true survives the re-init');
    assert.ok(
      fs.existsSync(path.join(cwd, ...DEFAULT_ADR_DIR.split('/'), 'README.md')),
      'ADR scaffold is (re)created since the recorded value is enabled',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- agents-default-install 2.1: retire the project-level `agents` target ---

test('init parseArgs throws for --agents and names forgekit install', () => {
  assert.throws(
    () => parseArgs(['--agents']),
    (err) => {
      assert.match(String(err.message), /forgekit install/);
      assert.doesNotMatch(String(err.message), /^Unknown argument: --agents$/);
      return true;
    },
  );
});

test('initAgentIds is AGENT_IDS (picker / --all / known-list)', () => {
  const ids = initAgentIds();
  assert.ok(!AGENT_IDS.includes('agents'), 'fixture sanity: install no longer offers agents');
  assert.ok(!ids.includes('agents'), 'init picker must not offer agents');
  assert.deepEqual(ids, [...AGENT_IDS]);
  assert.ok(ids.length > 0, 'fixture sanity: init still offers other environments');
});

test('initProject with the --all selection does not create .agents/', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-all-no-agents-'));
  try {
    initProject(initAgentIds(), { cwd, force: true, adr: false, planEngine: null });
    assert.equal(fs.existsSync(path.join(cwd, '.agents')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('forge init --all does not create a project .agents/ tree', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-all-spawn-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-all-spawn-home-'));
  try {
    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--all', '--force', '--no-openspec'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, `forge init --all failed: ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(cwd, '.agents')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rememberedAgents drops leftover agents from user config and the old project marker', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-home-agents-filter-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-proj-agents-filter-'));
  try {
    saveUserConfig({ agents: ['agents', 'claude'] }, home);
    fs.mkdirSync(path.join(cwd, '.agents', 'skills', 'forge'), { recursive: true });

    const remembered = rememberedAgents(cwd, home);
    assert.ok(remembered.has('claude'), 'real install-config choice still remembered');
    assert.ok(!remembered.has('agents'), 'retired agents target is not a remembered init choice');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('forge init --agents exits non-zero and names forgekit install', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-agents-gone-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-agents-gone-home-'));
  try {
    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--agents'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /forgekit install/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('forge init --help does not describe a project --agents skill copy', () => {
  const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `forge init --help failed: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /copies the Forge skill/);
  assert.doesNotMatch(result.stdout, /\.agents\/skills\/forge/);
  assert.doesNotMatch(result.stdout, /minus the shared/);
});

test('non-TTY forge init with no agents does not list --agents', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-no-agents-flag-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-init-no-agents-flag-home-'));
  try {
    const result = spawnSync(process.execPath, [FORGE_BIN, 'init'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No agents specified/);
    assert.doesNotMatch(result.stderr, /--agents/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- agents-default-install 2.2: retire a stamped project `.agents/skills/forge` copy ---

function plantAgentsForgeCopy(cwd, { stamped, extraFiles = {} }) {
  const dest = path.join(cwd, '.agents', 'skills', 'forge');
  fs.mkdirSync(dest, { recursive: true });
  const skillBody = '# leftover project forge skill\n';
  fs.writeFileSync(path.join(dest, 'SKILL.md'), skillBody, 'utf8');
  if (stamped) {
    fs.writeFileSync(
      path.join(dest, FORGEKIT_STAMP),
      `${JSON.stringify({ skill: 'forge', version: '0.3.48' }, null, 2)}\n`,
      'utf8',
    );
  }
  for (const [rel, body] of Object.entries(extraFiles)) {
    const file = path.join(cwd, '.agents', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  return dest;
}

test('initProject retires a stamped .agents/skills/forge copy and reports it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-stamped-'));
  try {
    const dest = plantAgentsForgeCopy(cwd, { stamped: true });
    assert.ok(fs.existsSync(path.join(dest, FORGEKIT_STAMP)), 'fixture sanity: stamp present');

    const report = initProject(['cursor'], { cwd, force: true, adr: false, planEngine: null });

    assert.equal(fs.existsSync(dest), false, 'stamped copy must be removed');
    assert.equal(report.agentsSkillRetired.status, 'retired');
    assert.equal(report.agentsSkillRetired.dest, '.agents/skills/forge');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject leaves an unstamped .agents/skills/forge copy and .agents/agents.md byte-identical', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-unstamped-'));
  try {
    const dest = plantAgentsForgeCopy(cwd, {
      stamped: false,
      extraFiles: { 'agents.md': '# user notes\n' },
    });
    const skillBefore = fs.readFileSync(path.join(dest, 'SKILL.md'));
    const notesBefore = fs.readFileSync(path.join(cwd, '.agents', 'agents.md'));
    assert.equal(fs.existsSync(path.join(dest, FORGEKIT_STAMP)), false, 'fixture sanity: no stamp');

    const report = initProject(['cursor'], { cwd, force: true, adr: false, planEngine: null });

    assert.equal(report.agentsSkillRetired, undefined);
    assert.ok(fs.existsSync(dest), 'unstamped copy must remain');
    assert.ok(fs.readFileSync(path.join(dest, 'SKILL.md')).equals(skillBefore));
    assert.ok(fs.readFileSync(path.join(cwd, '.agents', 'agents.md')).equals(notesBefore));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('initProject does not touch a foreign skill when retiring a stamped forge copy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-foreign-'));
  try {
    const dest = plantAgentsForgeCopy(cwd, {
      stamped: true,
      extraFiles: { 'skills/other-skill/SKILL.md': '# other skill\n' },
    });
    const foreignBefore = fs.readFileSync(
      path.join(cwd, '.agents', 'skills', 'other-skill', 'SKILL.md'),
    );

    const report = initProject(['cursor'], { cwd, force: true, adr: false, planEngine: null });

    assert.equal(fs.existsSync(dest), false, 'stamped forge copy retired');
    assert.equal(report.agentsSkillRetired.status, 'retired');
    assert.ok(
      fs.readFileSync(path.join(cwd, '.agents', 'skills', 'other-skill', 'SKILL.md')).equals(foreignBefore),
      'foreign skill left byte-identical',
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('forge init --cursor prints a retirement line for a stamped project copy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-stdout-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-stdout-home-'));
  try {
    plantAgentsForgeCopy(cwd, { stamped: true });
    const result = spawnSync(process.execPath, [FORGE_BIN, 'init', '--cursor', '--force', '--no-openspec'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, `forge init failed: ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(cwd, '.agents', 'skills', 'forge')), false);
    assert.match(result.stdout, /Retired leftover project copy: \.agents\/skills\/forge/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('claude init does not ship or wire the retired auto-triage hook', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-no-triage-hook-'));
  try {
    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });
    assert.equal(
      fs.existsSync(path.join(cwd, '.claude', 'hooks', 'forge-triage-hook.mjs')),
      false,
    );
    const snippet = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'forge-hooks.snippet.json'), 'utf8'),
    );
    const settings = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'),
    );
    const blob = `${JSON.stringify(snippet)}${JSON.stringify(settings)}`;
    assert.equal(blob.includes('forge-triage-hook.mjs'), false);
    assert.equal(
      fs.existsSync(path.join(cwd, '.claude', 'hooks', 'forge-prompt-hook.mjs')),
      true,
    );
    assert.ok(blob.includes('forge-prompt-hook.mjs'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('claude init deletes leftover forge-triage-hook.mjs and strips it from settings', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgekit-retire-triage-'));
  try {
    const hooksDir = path.join(cwd, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'forge-triage-hook.mjs'), '// leftover\n');
    const triageCmd =
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-triage-hook.mjs"';
    const promptCmd =
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-prompt-hook.mjs"';
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: triageCmd },
                { type: 'command', command: promptCmd },
              ],
            },
          ],
        },
      }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: triageCmd }] }],
        },
      }, null, 2)}\n`,
    );

    initProject(['claude'], { cwd, force: true, adr: false, planEngine: null });

    assert.equal(fs.existsSync(path.join(hooksDir, 'forge-triage-hook.mjs')), false);
    const settings = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'),
    );
    const local = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    );
    assert.equal(JSON.stringify(settings).includes('forge-triage-hook.mjs'), false);
    assert.equal(JSON.stringify(local).includes('forge-triage-hook.mjs'), false);
    assert.ok(JSON.stringify(settings).includes('forge-prompt-hook.mjs'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
