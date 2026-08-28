import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = path.join(
  REPO_ROOT,
  'skills',
  'forge',
  'skills',
  'specs-verify-change',
  'SKILL.md',
);

test('specs-verify-change skill exists and names Remaining: none plus leftover-name search', () => {
  assert.equal(
    fs.existsSync(SKILL),
    true,
    'skills/forge/skills/specs-verify-change/SKILL.md must exist',
  );
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.match(text, /Remaining: none/);
  assert.match(text, /leftover-name search/i);
  assert.match(text, /\bspec-verify\.md/);
  assert.match(text, /<plan\.dir>\/changes\/<name>\//);
  assert.match(text, /Completeness/i);
  assert.match(text, /Correctness/i);
  assert.match(text, /Coherence/i);
  assert.match(text, /CRITICAL/);
  assert.match(text, /WARNING/);
  assert.match(text, /SUGGESTION/);
  assert.match(text, /coordinator/i);
  assert.match(text, /not the final reviewer/i);
  assert.match(text, /changes\/archive\//);
  assert.match(text, /## Forge disposition/);
  assert.doesNotMatch(text, /openspec (status|instructions|list)/i);
});

/** Docs and commands that must point at the specs leftover skill (task 3.2). */
const LEFTOVER_COPY_RELS = Object.freeze([
  path.join('skills', 'forge', 'phases', 'verify.md'),
  path.join('skills', 'forge', 'phases', 'close.md'),
  path.join('skills', 'forge', 'skills', 'verification-before-completion', 'SKILL.md'),
  path.join('skills', 'forge', 'skills', 'subagent-driven-development', 'SKILL.md'),
  path.join('skills', 'forge', 'subagents', 'final-reviewer-prompt.md'),
  path.join('skills', 'forge', 'docs', 'forge.md'),
  path.join('skills', 'forge', 'references', 'forge-layout.md'),
  path.join('.cursor', 'commands', 'forge-apply.md'),
  path.join('.claude', 'commands', 'forge-apply.md'),
  path.join('templates', 'project', 'cursor', 'commands', 'forge-apply.md'),
  path.join('templates', 'project', 'claude', 'commands', 'forge-apply.md'),
]);

test('verify/close/apply copy names spec-verify.md for specs and openspec-verify.md for OpenSpec', () => {
  for (const rel of LEFTOVER_COPY_RELS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.match(
      text,
      /\bspec-verify\.md/,
      `${rel} must name spec-verify.md for specs leftover`,
    );
    assert.match(
      text,
      /\bopenspec-verify\.md/,
      `${rel} must still name openspec-verify.md for OpenSpec leftover`,
    );
  }
});

test('verify.md §7 always runs specs-verify-change and does not invent a parallel OpenSpec sweep', () => {
  const text = fs.readFileSync(
    path.join(REPO_ROOT, 'skills', 'forge', 'phases', 'verify.md'),
    'utf8',
  );
  assert.match(text, /specs-verify-change/);
  assert.match(text, /\bspec-verify\.md/);
  assert.match(text, /\bopenspec-verify\.md/);
  assert.match(text, /do not invent a parallel sweep/i);
});

function changelogSection(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## )`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}

test('operator docs name spec-verify.md for specs leftover and keep openspec-verify.md', () => {
  const usage = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'usage.md'), 'utf8');
  assert.match(usage, /\bspec-verify\.md/, 'docs/usage.md must name spec-verify.md');
  assert.match(
    usage,
    /\bopenspec-verify\.md/,
    'docs/usage.md must still name openspec-verify.md for OpenSpec leftover',
  );

  const dayToDay = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'day-to-day.md'), 'utf8');
  assert.match(
    dayToDay,
    /\bspec-verify\.md/,
    'docs/day-to-day.md must name spec-verify.md for specs leftover',
  );
  assert.match(
    dayToDay,
    /\bopenspec-verify\.md|openspec-verify-change/,
    'docs/day-to-day.md must still mention OpenSpec leftover sweep',
  );

  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const v0351 = changelogSection(changelog, '0\\.3\\.51 — 2026-08-28');
  assert.match(
    v0351,
    /\bspec-verify\.md/,
    'CHANGELOG 0.3.51 must describe the specs leftover sweep',
  );
  assert.doesNotMatch(
    v0351,
    /specs-engine sessions skip/i,
    '0.3.51 must not claim specs sessions skip leftover sweep',
  );
  const v0350 = changelogSection(changelog, '0\\.3\\.50 — 2026-08-27');
  assert.match(
    v0350,
    /Specs-engine sessions skip the\s+gate/,
    '0.3.50 history still records the skip that Unreleased supersedes',
  );
});
