import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { reviewCensus } from './review-census.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * A session dir with review artifacts.
 *
 * @param {Record<string, string>} groups  `<dir>/<file>` → body
 * @param {string | null} [final]
 */
function sessionWith(groups, final = null) {
  const dir = tmp('forge-census-');
  for (const [rel, body] of Object.entries(groups)) {
    const file = path.join(dir, 'tasks', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  if (final !== null) {
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviews', 'final-review.md'), final, 'utf8');
  }
  return dir;
}

test('a review is independent unless it says otherwise', () => {
  // 0.3.24 inverted this: independence had to be claimed via a `Reviewer:`
  // attribution, and anything unattributed was a self-check. An independent
  // review measured it and it was wrong in both directions — a real dispatched
  // review heading with `Reviewed:` demoted, while `coordinator self-audit`
  // promoted. Because set-phase.mjs gates `forge phase done` on this function,
  // the demotion refused correct high-risk sessions whose independent final
  // review already existed. Reverted; F9 is reopened.
  const dir = sessionWith({
    '01-a/group-review.md': '# Group review\n\n**Verdict: APPROVED**\n\nLooks good.\n',
    '02-b/group-review.md': '# Group 2 review\n\nReviewed: transcript reader.\n\nAPPROVED\n',
  });
  const census = reviewCensus(dir);

  assert.equal(census.total, 2);
  assert.equal(census.independent, 2);
  assert.equal(census.selfChecks, 0);
});

test('the phrases the templates emit are read as self-checks', () => {
  for (const body of [
    'APPROVED (pace self-check)',
    '# Review\n\nThis is a SELF-REVIEW, not an independent one.\n',
    'Reviewed by the coordinator in-session.\n',
  ]) {
    const dir = sessionWith({ '01-a/group-review.md': body });
    assert.equal(reviewCensus(dir).selfChecks, 1, body.slice(0, 48));
    assert.equal(reviewCensus(dir).independent, 0, body.slice(0, 48));
  }
});

test('the self-declarations the skill and the corpus actually use are caught', () => {
  // These are load-bearing: `skills/forge/phases/implement.md` tells the
  // coordinator to head a self-written review `self-check`, and the live corpus
  // uses `coordinator self-audit`. Under an inference model an unrecognised
  // declaration reads as INDEPENDENT, so a phrase Forge itself prescribes would
  // defeat the money/auth done gate. Caught by an independent review of the
  // revert, before publish.
  for (const body of [
    'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n',
    '**Verdict: APPROVED** · coordinator self-audit\n',
    '- **Reviewer:** coordinator (**self-check, not independent**) — dispatch was declined\n',
    '# Review\n\nSelf-authored; no outside reader was dispatched.\n',
  ]) {
    const dir = sessionWith({ '01-a/group-review.md': body });
    assert.equal(reviewCensus(dir).selfChecks, 1, body.split('\n')[0]);
  }
});

test('F9: a self-authored review in unrecognised words still counts as independent', {
  todo: 'reopened finding F9 — needs a dispatch-time stamp, not a wider regex',
}, () => {
  // Deliberately a todo, not an assertion of the current behaviour. The first
  // draft of this test asserted `independent === 2` with the message "known
  // over-credit", which meant the only executable statement about F9 in the
  // repo *required* the bug — fixing it would have turned this red. An
  // independent review flagged that as enforcement dressed as documentation.
  const dir = sessionWith({
    '01-a/group-review.md': '# Review\n\nI wrote this change and I read it back. APPROVED.\n',
  });
  assert.equal(reviewCensus(dir).selfChecks, 1, 'prose cannot measure authorship — see F12');
});

test('a reviewer discussing the coordinator self-checks is still independent', () => {
  // The fix for the skill/census mismatch first matched the self-declarations
  // against the WHOLE body, so a dispatched reviewer doing the ordinary thing —
  // naming which groups were self-checked — was demoted, and because
  // set-phase.mjs gates on this function it refused correct work. C1's failure
  // class, reintroduced by C1's own fix, under a comment claiming it could not
  // happen. Caught by an independent review before publish.
  for (const body of [
    'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n\n## Coverage\n\nThe group-03 review is a coordinator self-check rather than a dispatched read.\n',
    'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n\nGroups 3-6 are self-authored reviews by the coordinator.\n',
    'Reviewer: claude-opus-5 (task-reviewer)\n\nAPPROVED\n\nThe pace self-check on task 4 missed the null case.\n',
  ]) {
    const dir = sessionWith({}, body);
    assert.equal(reviewCensus(dir).finalReview, 'independent', body.split('\n')[4] ?? body);
  }
});

test('a self-declaration is read wherever attribution actually lives', () => {
  // Opening lines, or any line that opens by naming a reviewer — including one
  // far down the file. Spaced variants count: `self check` reads the same as
  // `self-check` to everyone except a regex that forgets to say so.
  for (const body of [
    'Reviewer: coordinator - self check\n\nAPPROVED\n',
    'APPROVED (pace self check)\n',
    '# Group review\n\n## Summary\n\nlots of prose\n\nmore prose\n\n- **Reviewer:** coordinator, self-audit\n',
  ]) {
    const dir = sessionWith({ '01-a/group-review.md': body });
    assert.equal(reviewCensus(dir).selfChecks, 1, body.split('\n')[0]);
  }
});

test('naming the coordinator as the reviewer is a self-declaration', () => {
  // The escape 0.3.26 shipped with, found by a design review after publish. The
  // real helm artifact opens `**Reviewer:** coordinator` and its very next words
  // are "a final-reviewer subagent was dispatched and declined by the operator";
  // it classified as independent on a high-risk session with no waiver.
  for (const body of [
    '# Final review\n\n**Verdict: APPROVED**\n**Reviewer:** coordinator. A final-reviewer subagent was dispatched and\ndeclined by the operator.\n',
    'Reviewer: the coordinator\n\nAPPROVED\n',
    'Reviewer: the author\n\nAPPROVED\n',
  ]) {
    assert.equal(reviewCensus(sessionWith({}, body)).finalReview, 'self', body.split('\n')[0]);
  }

  // Adjacency is one guard: only punctuation and emphasis may sit between the
  // attribution and the name, so a dispatched reviewer who merely says who
  // dispatched them stays independent. The trailing `(?!-)` is the other —
  // `coordinator-dispatched` uses the word as an adjective, and demoting on it
  // would refuse work at the gate. Found by an adversarial pass before ship.
  for (const body of [
    'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n',
    'Reviewer: claude-opus-5, dispatched by the coordinator for group 3.\n\n**READY**\n',
    'Reviewer: coordinator-dispatched opus subagent\n\n**READY**\n',
    'Reviewer: authored by claude-opus-5\n\n**READY**\n',
    'Reviewer: independent task reviewer, single pass.\n\nAPPROVED\n',
  ]) {
    assert.equal(reviewCensus(sessionWith({}, body)).finalReview, 'independent', body.split('\n')[0]);
  }
});

test('a hard-wrapped declaration is still a declaration', () => {
  // The real volo final review. Its attribution wraps across three lines and
  // the word `self-review` lands on the third, so a line-counted window
  // promoted a session whose own text says dispatch was declined twice — on a
  // high-risk change, past the money/auth gate. Prose wraps; regexes do not.
  // Same failure the `contract` narrowing was reverted for, one release later.
  const body =
    '# Final review — add-accountant-monthly-bundle (whole change)\n\n' +
    '**Reviewer:** the coordinator, reading the complete diff directly. Subagent dispatch was\n' +
    'declined twice by the operator, so this is a self-review rather than an independent one —\n' +
    'stated plainly because it is a weaker signal than an outside reader.\n';
  assert.equal(reviewCensus(sessionWith({}, body)).finalReview, 'self');

  // The window is two paragraphs, and both edges matter: one paragraph would
  // miss a title-then-attribution file, three would swallow body prose.
  const third =
    '# Title\n\n**Reviewer:** claude-opus-5 (final-reviewer)\n\nGroups 3-6 were self-authored.\n';
  assert.equal(reviewCensus(sessionWith({}, third)).finalReview, 'independent');
});

test('quoting another review header is not declaring your own', () => {
  // A dispatched reviewer showing you what group 3's review says. Fenced,
  // blockquoted and indented forms are all a quotation.
  for (const quote of [
    '> Reviewer: coordinator — self-check',
    '```\nReviewer: coordinator — self-check\n```',
    '    Reviewer: coordinator — self-check',
  ]) {
    const body = `Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n\nGroup 03 is headed:\n\n${quote}\n\nso I re-read that code directly.\n`;
    assert.equal(reviewCensus(sessionWith({}, body)).finalReview, 'independent', quote.slice(0, 32));
  }
});

test('a quoted attribution inside the opening paragraphs is still a quotation', () => {
  // Verified correct but untested: deleting the blockquote exclusion passes the
  // suite, because dropping `>` from the prefix class makes a quoted line
  // beyond the window unreachable anyway. Inside the window it is load-bearing.
  const body =
    'Reviewer: claude-opus-5 (final-reviewer)\n' +
    '> Reviewer: coordinator — self-check\n\n' +
    '**READY**\n';
  assert.equal(reviewCensus(sessionWith({}, body)).finalReview, 'independent');
});

test('every fence style hides a quoted attribution', () => {
  // ``` and ~~~, at any indent markdown accepts. Behaviour was right; nothing
  // pinned the tilde form or the indented opener.
  for (const fence of ['```', '~~~', '  ```', '   ~~~']) {
    const body =
      `Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n\nGroup 3 reads:\n\n` +
      `${fence}\nReviewer: coordinator — self-check\n${fence.trim()}\n\nso I re-read it.\n`;
    assert.equal(
      reviewCensus(sessionWith({}, body)).finalReview,
      'independent',
      `fence ${JSON.stringify(fence)}`,
    );
  }
});

test('an attribution must open its line — prose about a reviewer does not count', () => {
  // The `^` anchor is the entire difference between the two, and nothing
  // tested it until an independent review pointed out the mutant survived.
  const prose =
    'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n\n' +
    'I checked whether the reviewer self-check on group 3 covered the null case.\n';
  assert.equal(reviewCensus(sessionWith({}, prose)).finalReview, 'independent');

  const declared = '# Review\n\nnotes\n\nmore notes\n\nReviewer: coordinator — self-audit\n';
  assert.equal(reviewCensus(sessionWith({}, declared)).finalReview, 'self');
});

test('the final review is classified by the same rule', () => {
  const independent = sessionWith({}, '# Final review\n\nReviewer: opus 4d2 — READY.\n');
  assert.equal(reviewCensus(independent).finalReview, 'independent');

  const self = sessionWith({}, '# Final review\n\nThis is a self-review by the author.\n');
  assert.equal(reviewCensus(self).finalReview, 'self');

  assert.equal(reviewCensus(sessionWith({})).finalReview, null, 'absent is not the same as self');
});

test('rejection rounds are still counted, on either kind of review', () => {
  const dir = sessionWith(
    {
      '01-a/group-review.md':
        '**Verdict: APPROVED** (opus reviewer 9f2)\n\n## Round 1 — REJECTED\n',
    },
    '# Final review\n\nA self-review.\n\nRound 1 REJECTED.\n',
  );
  const census = reviewCensus(dir);
  assert.equal(census.rejections, 2);
  assert.equal(census.independent, 1);
  assert.equal(census.finalReview, 'self');
});

test('a session with no review artifacts at all counts nothing', () => {
  const empty = { total: 0, independent: 0, selfChecks: 0, rejections: 0, finalReview: null };
  assert.deepEqual(reviewCensus(sessionWith({})), empty);
  assert.deepEqual(reviewCensus('/nonexistent/path'), empty);
});

test('the real corpus case that forced the revert', () => {
  // This project's own group-02 review: a dispatched reviewer that found a
  // 28.6% output-token undercount and rejected the work. It never uses the
  // token "reviewer" — it heads with `Reviewed:` — so the 0.3.24 rule called it
  // a self-check and, through the done gate, refused the session.
  const real = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '..',
    '..',
    '.forge',
    'sessions',
    '20260727T152246Z-session-telemetry-2b7ef4',
    'tasks',
    'group-02-transcript-reader',
    'group-review.md',
  );
  if (!fs.existsSync(real)) return; // the session dir is prunable; skip rather than fail
  const body = fs.readFileSync(real, 'utf8');
  assert.equal(/reviewer/i.test(body), false, 'the artifact that broke the attribution rule');

  const dir = sessionWith({ '01-a/group-review.md': body });
  assert.equal(reviewCensus(dir).independent, 1, 'a dispatched review must not read as self');
});
