import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySkillFooter,
  patchOpsxApplyContent,
  stripOverlayBlock,
} from './vendor-openspec-overlays.mjs';

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
  assert.match(content, /Dispatch \*\*implementer\*\* subagent/);
  assert.doesNotMatch(content, /Make the code changes required/);
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

test('stripOverlayBlock removes footer', () => {
  const withFooter = applySkillFooter('body\n', 'cursor');
  const stripped = stripOverlayBlock(withFooter);
  assert.doesNotMatch(stripped, /forgekit:openspec-overlay/);
});
