/**
 * `forge init` wires the lease guard hook: Claude Code PreToolUse
 * (`Bash|PowerShell`) and Cursor `preToolUse` (`Shell`), copies the hook file,
 * and adds no permission rule for `forge lease`. Kept apart from init.test.mjs
 * (guarded); fixtures follow that file's style.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from './init.mjs';
import { checkHookWiring } from './doctor.mjs';

const HOOK = 'forge-lease-guard.mjs';

function withProject(prefix, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const init = (cwd, agents) => initProject(agents, { cwd, force: true, adr: false, planEngine: null });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Every PreToolUse hook leaf (with its group matcher) whose command runs the lease guard. */
function leaseGuardLeaves(settings) {
  const leaves = [];
  for (const group of settings.hooks?.PreToolUse ?? []) {
    for (const hook of group.hooks ?? []) {
      if (String(hook.command).includes(HOOK)) leaves.push({ matcher: group.matcher, ...hook });
    }
  }
  return leaves;
}

test('claude init: settings register the lease guard under PreToolUse with matcher Bash|PowerShell', () => {
  withProject('forgekit-lease-guard-claude-', (cwd) => {
    init(cwd, ['claude']);
    const settings = readJson(path.join(cwd, '.claude', 'settings.json'));
    const leaves = leaseGuardLeaves(settings);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].matcher, 'Bash|PowerShell');
    assert.equal(leaves[0].type, 'command');
    assert.equal(leaves[0].command, `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${HOOK}"`);
    assert.equal(leaves[0].statusMessage, undefined, 'no status flash on every shell call');
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'hooks', HOOK)), 'hook file copied next to resolve-forge.mjs');
    assert.ok(fs.existsSync(path.join(cwd, '.claude', 'hooks', 'resolve-forge.mjs')));

    // The other PreToolUse hooks are still there, untouched.
    const snippet = readJson(path.join(cwd, '.claude', 'forge-hooks.snippet.json'));
    assert.equal(settings.hooks.PreToolUse.length, snippet.hooks.PreToolUse.length);
    assert.ok(settings.hooks.PreToolUse.some((g) => g.matcher === 'Edit|Write|NotebookEdit|MultiEdit'));
    assert.match(snippet._comment, /lease/i, 'the snippet comment explains the guard is inert without configured leases');
  });
});

test('claude init: running init again leaves exactly one lease guard entry', () => {
  withProject('forgekit-lease-guard-twice-', (cwd) => {
    init(cwd, ['claude']);
    const first = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    init(cwd, ['claude']);
    const second = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    assert.equal(leaseGuardLeaves(JSON.parse(second)).length, 1);
    assert.equal(second, first, 'settings.json is stable across re-init');
  });
});

test('claude init: a project wired before the lease guard existed gains it once', () => {
  withProject('forgekit-lease-guard-upgrade-', (cwd) => {
    init(cwd, ['claude']);
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes(HOOK));
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    assert.equal(leaseGuardLeaves(readJson(settingsPath)).length, 0);

    init(cwd, ['claude']);
    assert.equal(leaseGuardLeaves(readJson(settingsPath)).length, 1);
  });
});

test('claude init: adds no permission allow rule for forge lease', () => {
  withProject('forgekit-lease-guard-perms-', (cwd) => {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`,
      'utf8',
    );
    init(cwd, ['claude']);
    const settings = readJson(path.join(cwd, '.claude', 'settings.json'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'permissions pass through untouched');
    for (const file of ['settings.json', 'forge-hooks.snippet.json']) {
      const text = fs.readFileSync(path.join(cwd, '.claude', file), 'utf8');
      assert.doesNotMatch(text, /Bash\([^)]*forge lease/, `${file} has no allow rule for forge lease`);
    }
  });
});

test('claude init: doctor sees the lease guard as wired, and flags it once unwired', () => {
  withProject('forgekit-lease-guard-doctor-', (cwd) => {
    init(cwd, ['claude']);
    const wired = checkHookWiring({ cwd });
    assert.ok(wired.surfaces.find((s) => s.surface === 'claude').present.includes(HOOK));
    assert.equal(wired.ok, true, wired.message);

    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes(HOOK));
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const unwired = checkHookWiring({ cwd });
    assert.equal(unwired.ok, false);
    assert.ok(unwired.surfaces.find((s) => s.surface === 'claude').unwired.includes(HOOK));
  });
});

test('cursor init: hooks.json gets the Shell preToolUse entry once and keeps sessionStart', () => {
  withProject('forgekit-lease-guard-cursor-', (cwd) => {
    init(cwd, ['cursor']);
    const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
    const doc = readJson(hooksPath);
    const pre = doc.hooks.preToolUse.filter((h) => String(h.command).includes(HOOK));
    assert.equal(pre.length, 1);
    assert.equal(pre[0].command, `node .cursor/hooks/${HOOK} --format cursor`);
    assert.equal(pre[0].matcher, 'Shell');
    assert.ok(doc.hooks.sessionStart.some((h) => String(h.command).includes('forge-session-start')));
    assert.ok(fs.existsSync(path.join(cwd, '.cursor', 'hooks', HOOK)), 'hook file copied');

    init(cwd, ['cursor']);
    const again = readJson(hooksPath);
    assert.equal(again.hooks.preToolUse.filter((h) => String(h.command).includes(HOOK)).length, 1);
    assert.equal(again.hooks.sessionStart.filter((h) => String(h.command).includes('forge-session-start')).length, 1);

    const snippet = readJson(path.join(cwd, '.cursor', 'forge-hooks.snippet.json'));
    assert.ok(snippet.hooks.preToolUse.some((h) => String(h.command).includes(HOOK)), 'snippet lists the lease guard');
    assert.equal(checkHookWiring({ cwd }).ok, true);
  });
});

test('cursor init: existing preToolUse hooks survive', () => {
  withProject('forgekit-lease-guard-cursor-merge-', (cwd) => {
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.cursor', 'hooks.json'),
      `${JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'echo mine', matcher: 'Write' }] } }, null, 2)}\n`,
      'utf8',
    );
    init(cwd, ['cursor']);
    const pre = readJson(path.join(cwd, '.cursor', 'hooks.json')).hooks.preToolUse;
    assert.ok(pre.some((h) => h.command === 'echo mine' && h.matcher === 'Write'));
    assert.equal(pre.filter((h) => String(h.command).includes(HOOK)).length, 1);
  });
});

test('claude init: a project wired with the old statusMessage entry is not given a second lease guard', () => {
  withProject('forgekit-lease-guard-oldstatus-', (cwd) => {
    init(cwd, ['claude']);
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    for (const group of settings.hooks.PreToolUse) {
      for (const hook of group.hooks) if (String(hook.command).includes(HOOK)) hook.statusMessage = 'Checking resource leases';
    }
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}
`, 'utf8');

    init(cwd, ['claude']);
    const leaves = leaseGuardLeaves(readJson(settingsPath));
    assert.equal(leaves.length, 1, 'deduped by command string, not by the whole entry');
  });
});
