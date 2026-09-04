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
  assert.match(text, /\{TASK_LIST\}/);
  assert.match(text, /\{TASK_IDS\}/);
  assert.match(text, /\{TASK_ID\}/);
  // A multi-task unit still stamps red→green per task; that is the whole
  // difference between a cheaper dispatch and a weaker one.
  assert.match(text, /one task at a time/i);
  assert.match(text, /per\s*\n?\s*task/i);
  assert.match(text, /forge tdd run --session \{SESSION_ID\} --task \{TASK_ID\} --expect fail/);
  assert.match(text, /forge tdd run --session \{SESSION_ID\} --task \{TASK_ID\} --expect pass/);
  assert.match(text, /\.forge\/sessions\/\{SESSION_ID\}\/tasks\/\{TASK_ID\}\/tdd-runs\.jsonl/);
});

test('reviewer packet validates flagged tasks from the same executed ledger', () => {
  const text = fs.readFileSync(packet('task-reviewer-prompt.md'), 'utf8');
  assert.match(text, /\{TASK_EVIDENCE_TARGETS\}/);
  assert.match(text, /one entry per reviewed task/i);
  // Ledger inspection moved into `forge review-precheck`; the reviewer judges
  // reasons, it does not re-run suites or re-read ledgers.
  assert.match(text, /do not re-run test\s+suites or re-inspect ledgers/i);
  assert.match(text, /plain .*test-evidence\.md.*supplemental/is);
});


test('both reviewer packets scope the review to a required diff range', () => {
  // Reviewer input cost is repo-sized or change-sized depending on this alone.
  // A reviewer with no range rebuilds one by reading the tree, which is where
  // the input-token multiple came from.
  for (const name of ['task-reviewer-prompt.md', 'final-reviewer-prompt.md', 'closer-prompt.md']) {
    const text = fs.readFileSync(packet(name), 'utf8');
    assert.match(text, /\{DIFF_RANGE\}/, `${name} must carry a diff-range placeholder`);
    assert.match(text, /REQUIRED/, `${name} must mark the range required`);
    assert.match(text, /NEEDS_CONTEXT/, `${name} must refuse an unfilled range`);
    // Every reviewer packet carries the machine-verified block so no reviewer
    // pays to re-derive integrity, ledger pairing or allowances.
    assert.match(text, /\{PRECHECK\}/, `${name} must carry the precheck placeholder`);
    assert.match(text, /do not re-run/i, `${name} must tell the reviewer not to re-run verified checks`);
    assert.match(
      text,
      /do not (?:explore|substitute a survey|reconstruct)|no directory sweeps/i,
      `${name} must ban undirected repository exploration`,
    );
  }
});

test('closer packet is a real final reviewer: evidence targets, tier-3 command, attribution', () => {
  const text = fs.readFileSync(packet('closer-prompt.md'), 'utf8');
  assert.match(text, /\{TASK_EVIDENCE_TARGETS\}/);
  assert.match(text, /\{AFFECTED_TEST_COMMAND\}/);
  assert.doesNotMatch(text, /\{GUARD_ALLOWANCES\}/, 'allowances arrive inside {PRECHECK}');
  assert.match(text, /Reviewer: <your model> \(closer\)/);
  assert.match(text, /READY/);
});

test('close phase labels the closer as the final reviewer and caps the fix loop', () => {
  const text = fs.readFileSync(path.join(skillsRoot, 'forge', 'phases', 'close.md'), 'utf8');
  assert.match(text, /forge review-label final/);
  assert.match(text, /resolvedCeremony/);
  assert.match(text, /at most one/i);
  // The gates stay: close.md must route through phase done / integrity-check.
  assert.match(text, /forge phase done/);
  assert.match(text, /integrity-check/);
  // Cohort 5: all four final reviews were saved without a Reviewer: line and
  // graded from silence. The save step owns the attribution check.
  assert.match(text, /first line/i);
  assert.match(text, /Reviewer: <model> \(closer\)/);
});

test('review phase tells the coordinator to fill the final reviewer diff range', () => {
  const text = fs.readFileSync(path.join(skillsRoot, 'forge', 'phases', 'review.md'), 'utf8');
  assert.match(text, /\{DIFF_RANGE\}/);
  assert.match(text, /forge checkpoint --range/);
});

test('implement phase tells the coordinator to fill every evidence target placeholder', () => {
  const text = fs.readFileSync(path.join(skillsRoot, 'forge', 'phases', 'implement.md'), 'utf8');
  // A unit brief carries a list of tasks, so the coordinator fills {TASK_LIST}
  // and {TASK_IDS} where it used to fill a single {TASK_ID}.
  for (const placeholder of ['{SESSION_ID}', '{TASK_LIST}', '{TASK_IDS}', '{TASK_EVIDENCE_TARGETS}']) {
    assert.match(text, new RegExp(placeholder.replace(/[{}]/g, '\\$&')));
  }
  assert.match(text, /forge tdd run --session <id> --task <task-id>/);
  assert.match(text, /one entry per reviewed task/i);
});
