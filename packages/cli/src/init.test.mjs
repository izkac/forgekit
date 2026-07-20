import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, initProject, rememberedAgents } from './init.mjs';
import { installSkillsToAgents } from './install.mjs';
import { saveUserConfig } from './config.mjs';

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
    // Actually installed skill for another env.
    installSkillsToAgents(['forge'], ['copilot'], { home, force: true });
    // Project already wired for cursor.
    fs.mkdirSync(path.join(cwd, '.cursor', 'commands'), { recursive: true });

    const remembered = rememberedAgents(cwd, home);
    assert.ok(remembered.has('claude'), 'from install config');
    assert.ok(remembered.has('gemini'), 'from install config');
    assert.ok(remembered.has('copilot'), 'from installed skill dir');
    assert.ok(remembered.has('cursor'), 'from project wiring marker');
    assert.ok(!remembered.has('codex'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
