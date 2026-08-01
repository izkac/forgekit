/**
 * Pin: forgekit dogsfoods Claude PreToolUse model-policy hooks in-repo (F64).
 *
 * Asserts the committed checkout (not a temp init) ships the hook body and a
 * real `.claude/settings.json` that registers PreToolUse → forge-model-hook.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('repo ships .claude/hooks/forge-model-hook.mjs', () => {
  const hook = path.join(REPO_ROOT, '.claude', 'hooks', 'forge-model-hook.mjs');
  assert.ok(fs.existsSync(hook), `missing ${path.relative(REPO_ROOT, hook)}`);
  assert.match(fs.readFileSync(hook, 'utf8'), /enforce-model/);
});

test('repo ships .claude/settings.json PreToolUse → forge-model-hook.mjs', () => {
  const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
  assert.ok(fs.existsSync(settingsPath), `missing ${path.relative(REPO_ROOT, settingsPath)}`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const pre = settings.hooks?.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length > 0, 'settings.hooks.PreToolUse missing');
  const commands = pre.flatMap((entry) =>
    (entry.hooks ?? []).map((h) => String(h.command ?? '')),
  );
  assert.ok(
    commands.some((c) => c.includes('forge-model-hook.mjs')),
    `PreToolUse must register forge-model-hook.mjs; got: ${JSON.stringify(commands)}`,
  );
  assert.ok(
    pre.some((entry) => entry.matcher === 'Agent|Task'),
    'PreToolUse matcher should be Agent|Task',
  );
});
