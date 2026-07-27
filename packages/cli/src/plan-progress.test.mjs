import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  countTasksMdCheckboxes,
  healSessionProgress,
  overlayPlanProgress,
  readPlanTaskProgress,
} from './plan-progress.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

test('countTasksMdCheckboxes counts checked and total checkbox lines', () => {
  const body = `# Tasks
## A
- [x] 1.1 done
- [ ] 1.2 todo
- [X] 1.3 also done
## Notes
- not a checkbox
`;
  assert.deepEqual(countTasksMdCheckboxes(body), { total: 3, complete: 2 });
});

test('countTasksMdCheckboxes returns zeros for empty body', () => {
  assert.deepEqual(countTasksMdCheckboxes(''), { total: 0, complete: 0 });
});

test('readPlanTaskProgress reads linked specs tasks.md', () => {
  const cwd = tmp('forge-plan-prog-');
  const changeDir = path.join(cwd, 'specs', 'changes', 'demo');
  fs.mkdirSync(changeDir, { recursive: true });
  const tasksFile = path.join(changeDir, 'tasks.md');
  fs.writeFileSync(tasksFile, '## G\n- [x] 1.1 a\n- [ ] 1.2 b\n', 'utf8');
  const then = Date.now() - 60_000;
  fs.utimesSync(tasksFile, then / 1000, then / 1000);

  const progress = readPlanTaskProgress({
    cwd,
    session: { planType: 'specs', openspecChange: 'demo' },
  });
  assert.ok(progress);
  assert.equal(progress.total, 2);
  assert.equal(progress.complete, 1);
  assert.ok(Math.abs(progress.mtimeMs - then) < 2000);
});

test('readPlanTaskProgress returns null when tasks.md is missing or has no checkboxes', () => {
  const cwd = tmp('forge-plan-prog-miss-');
  assert.equal(
    readPlanTaskProgress({ cwd, session: { planType: 'specs', openspecChange: 'nope' } }),
    null,
  );

  const changeDir = path.join(cwd, 'specs', 'changes', 'empty');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '# No boxes\n', 'utf8');
  assert.equal(
    readPlanTaskProgress({ cwd, session: { planType: 'specs', openspecChange: 'empty' } }),
    null,
  );
});

test('healSessionProgress writes session.json when checkbox counts diverge', () => {
  const cwd = tmp('forge-plan-heal-');
  const sessionDir = path.join(cwd, '.forge', 'sessions', 's1');
  const changeDir = path.join(cwd, 'specs', 'changes', 'demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] 1.1\n- [x] 1.2\n- [ ] 1.3\n', 'utf8');
  const session = {
    id: 's1',
    phase: 'implement',
    planType: 'specs',
    openspecChange: 'demo',
    tasksTotal: 46,
    tasksComplete: 0,
    updatedAt: '2000-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(session)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(sessionDir, 'status.json'),
    `${JSON.stringify({ tasksTotal: 46, tasksComplete: 0 })}\n`,
    'utf8',
  );

  const { changed, progress } = healSessionProgress({ cwd, sessionDir, session });
  assert.equal(changed, true);
  assert.equal(progress.complete, 2);
  assert.equal(session.tasksComplete, 2);
  assert.equal(session.tasksTotal, 3);
  const disk = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(disk.tasksComplete, 2);
  assert.notEqual(disk.updatedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(overlayPlanProgress(session, progress), false);
});
