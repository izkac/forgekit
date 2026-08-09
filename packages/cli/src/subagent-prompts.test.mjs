import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..', '..');
const sourceSkills = path.join(REPO_ROOT, 'skills');
const skillsRoot = fs.existsSync(sourceSkills) ? sourceSkills : path.join(CLI_ROOT, 'vendor', 'skills');
const packet = (name) => path.join(skillsRoot, 'forge', 'subagents', name);

test('implementer packet targets the coordinator session and returns its executed ledger', () => {
  const text = fs.readFileSync(packet('implementer-prompt.md'), 'utf8');
  assert.match(text, /\{SESSION_ID\}/);
  assert.match(text, /\{TASK_ID\}/);
  assert.match(text, /forge tdd run --session \{SESSION_ID\} --task \{TASK_ID\} --expect fail/);
  assert.match(text, /forge tdd run --session \{SESSION_ID\} --task \{TASK_ID\} --expect pass/);
  assert.match(text, /\.forge\/sessions\/\{SESSION_ID\}\/tasks\/\{TASK_ID\}\/tdd-runs\.jsonl/);
});

test('reviewer packet validates flagged tasks from the same executed ledger', () => {
  const text = fs.readFileSync(packet('task-reviewer-prompt.md'), 'utf8');
  assert.match(text, /\{TASK_EVIDENCE_TARGETS\}/);
  assert.match(text, /one entry per reviewed task/i);
  assert.match(text, /inspect every listed ledger/i);
  assert.match(text, /plain .*test-evidence\.md.*supplemental/is);
});


test('implement phase tells the coordinator to fill every evidence target placeholder', () => {
  const text = fs.readFileSync(path.join(skillsRoot, 'forge', 'phases', 'implement.md'), 'utf8');
  for (const placeholder of ['{SESSION_ID}', '{TASK_ID}', '{TASK_EVIDENCE_TARGETS}']) {
    assert.match(text, new RegExp(placeholder.replace(/[{}]/g, '\\$&')));
  }
  assert.match(text, /forge tdd run --session <id> --task <task-id>/);
  assert.match(text, /one entry per reviewed task/i);
});
