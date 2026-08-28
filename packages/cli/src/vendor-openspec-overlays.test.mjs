import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySkillFooter,
  patchOpsxApplyContent,
  stripOverlayBlock,
} from './vendor-openspec-overlays.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const VANILLA = `---
name: test
---

6. **Implement tasks (loop until done or blocked)**

   For each pending task:
   - Show which task is being worked on
   - Make the code changes required
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: \`- [ ]\` → \`- [x]\`
   - Continue to next task

   **Pause if:**
   - Task is unclear

7. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest archive
`;

test('patchOpsxApplyContent injects Forge implement step', () => {
  const { content, status } = patchOpsxApplyContent(VANILLA, 'cursor');
  assert.equal(status, 'patched');
  assert.match(content, /REQUIRED \(Forge\):/);
  assert.match(content, /\.cursor\/skills\/forge\/phases\/implement\.md/);
  assert.match(content, /Dispatch one \*\*implementer\*\* for the group/);
  assert.match(content, /Per pending `##` group/);
  assert.doesNotMatch(content, /Make the code changes required/);
  assert.doesNotMatch(content, /For each pending task/);
  assert.doesNotMatch(content, /\*\*spec\*\* \+ \*\*quality\*\* reviewers/);
});

test('patchOpsxApplyContent is idempotent on re-run', () => {
  const first = patchOpsxApplyContent(VANILLA, 'claude');
  const second = patchOpsxApplyContent(first.content, 'claude');
  assert.equal(second.status, 're-patched');
  assert.match(second.content, /\.claude\/skills\/forge\/phases\/verify\.md/);
});

test('applySkillFooter adds overlay block once', () => {
  const skill = '---\nname: openspec-apply-change\n---\n\nBody.\n';
  const once = applySkillFooter(skill, 'codex');
  assert.match(once, /forgekit:openspec-overlay:start/);
  assert.match(once, /\/forge:apply/);
  const twice = applySkillFooter(once, 'codex');
  assert.equal((twice.match(/## Forge overlay/g) || []).length, 1);
});

test('applySkillFooter can stamp the verify-change footer', () => {
  const skill = '---\nname: openspec-verify-change\n---\n\nBody.\n';
  const once = applySkillFooter(skill, 'cursor', undefined, 'openspec-verify-change-footer.md');
  assert.match(once, /Remaining: none/);
  assert.match(once, /tasks\.md/);
  const twice = applySkillFooter(once, 'cursor', undefined, 'openspec-verify-change-footer.md');
  assert.equal((twice.match(/## Forge overlay/g) || []).length, 1);
});

test('stripOverlayBlock removes footer', () => {
  const withFooter = applySkillFooter('body\n', 'cursor');
  const stripped = stripOverlayBlock(withFooter);
  assert.doesNotMatch(stripped, /forgekit:openspec-overlay/);
});

test('/forge:apply commands review per group, not per task with two reviewers', () => {
  const rels = [
    path.join('.cursor', 'commands', 'forge-apply.md'),
    path.join('.claude', 'commands', 'forge-apply.md'),
    path.join('templates', 'project', 'cursor', 'commands', 'forge-apply.md'),
    path.join('templates', 'project', 'claude', 'commands', 'forge-apply.md'),
  ];
  for (const rel of rels) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.match(text, /One \*\*implementer\*\* per `tasks\.md` \*\*group\*\*/, rel);
    assert.doesNotMatch(text, /Per pending task:/, rel);
    assert.doesNotMatch(text, /\*\*spec reviewer\*\*/, rel);
    assert.doesNotMatch(text, /\*\*quality reviewer\*\*/, rel);
  }
});
