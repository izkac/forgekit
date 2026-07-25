import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildFleetReport, formatFleetReport } from './fleet-report.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/** A project with a scorecards ledger and (optionally) session digests. */
function makeProject(name, { scores = [], digests = [], deferrals = [] } = {}) {
  const root = tmp(`fleet-report-${name}-`);
  if (scores.length) writeJsonl(path.join(root, '.forge', 'scorecards.jsonl'), scores);
  if (digests.length) writeJsonl(path.join(root, '.forge', 'sessions.jsonl'), digests);
  if (deferrals.length) writeJsonl(path.join(root, '.forge', 'deferrals.jsonl'), deferrals);
  return { project: root, projectName: name };
}

test('the report aggregates scores, grades and deductions across projects', () => {
  const a = makeProject('volo', {
    scores: [
      { sessionId: 's1', slug: 'one', score: 90, grade: 'A', caps: [], deductions: [{ id: 'product_loop', points: 11, max: 20 }] },
      { sessionId: 's2', slug: 'two', score: 80, grade: 'B', caps: [], deductions: [{ id: 'product_loop', points: 0, max: 20 }] },
    ],
  });
  const b = makeProject('helm', {
    scores: [{ sessionId: 's3', slug: 'three', score: 97, grade: 'A', caps: [], deductions: [{ id: 'product_loop', points: 17, max: 20 }] }],
  });

  const report = buildFleetReport([a, b]);

  assert.equal(report.totals.sessions, 3);
  assert.equal(report.totals.meanScore, 89);
  assert.deepEqual(report.totals.grades, { A: 2, B: 1 });
  // The deduction that costs the most points across the fleet leads.
  assert.equal(report.totals.topDeductions[0].id, 'product_loop');
  assert.equal(report.totals.topDeductions[0].lostPoints, 32);
  assert.equal(report.projects.length, 2);
  assert.equal(report.projects.find((p) => p.projectName === 'helm').meanScore, 97);
});

test('caps are counted, because a capped session is a process failure worth trending', () => {
  const p = makeProject('volo', {
    scores: [
      { sessionId: 's1', score: 69, grade: 'C', caps: ['high-risk session whose final review is self-authored — score capped at 69'], deductions: [] },
      { sessionId: 's2', score: 97, grade: 'A', caps: [], deductions: [] },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.capped, 1);
  assert.match(report.totals.capReasons[0], /self-authored/);
});

test('digests surface review coverage and rejection rounds next to the grade', () => {
  const p = makeProject('helm', {
    scores: [{ sessionId: 's1', score: 97, grade: 'A', caps: [], deductions: [] }],
    digests: [
      {
        sessionId: 's1',
        slug: 'phase-0',
        reviews: { total: 9, independent: 9, selfChecks: 0, rejections: 4, final: 'independent' },
        subagentsDispatched: 18,
        checkpoints: 3,
        health: 'done',
        durationHours: 1.2,
      },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.reviews.independent, 9);
  assert.equal(report.totals.reviews.rejections, 4);
  assert.equal(report.totals.subagents, 18);
  assert.equal(report.projects[0].sessions[0].grade, 'A');
});

test('open deferrals across projects are listed — carried debt is fleet-level', () => {
  const p = makeProject('volo', {
    scores: [{ sessionId: 's1', score: 90, grade: 'A', caps: [], deductions: [] }],
    deferrals: [
      { sessionId: 's1', task: '7.1', reason: 'grouping.ts D1 extraction', change: 'add-x' },
      { sessionId: 's1', task: '9.2', reason: 'PATCH /settings flattens 400s into 500s', change: 'add-x' },
    ],
  });
  const report = buildFleetReport([p]);
  assert.equal(report.totals.openDeferrals, 2);
  assert.match(report.openDeferrals[0].reason, /grouping\.ts/);
});

test('a project with no ledgers contributes nothing and does not throw', () => {
  const empty = makeProject('fresh');
  const report = buildFleetReport([empty]);
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.projects.length, 0, 'projects with no scored sessions are omitted');
  assert.match(formatFleetReport(report), /No scored sessions/);
});

test('the rendered report leads with the fleet summary', () => {
  const p = makeProject('volo', {
    scores: [{ sessionId: 's1', slug: 'one', score: 69, grade: 'C', caps: ['capped'], deductions: [{ id: 'reviews', points: 2, max: 5 }] }],
  });
  const text = formatFleetReport(buildFleetReport([p]));
  assert.match(text, /1 session/);
  assert.match(text, /volo/);
  assert.match(text, /reviews/);
});
