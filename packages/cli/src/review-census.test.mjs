import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CENSUS_RULE, FINAL_REVIEW_REQUEST_FLOOR, reviewCensus } from './review-census.mjs';
import { writeStamp } from './review-stamp.mjs';
import { reviewEvidence } from './metrics/review-evidence.mjs';
import { installFsFaults } from './test-support/fs-fault.mjs';
import {
  assistantLine,
  meta,
  plantHost,
} from './metrics/test-host-tree.mjs';

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

test('instructional REJECT if prose with APPROVED does not count as a rejection', () => {
  // F59: reviewers recite "REJECT if any of: …" then APPROVE; the old token
  // matcher counted that as a rejection round. Only structural Round/Verdict
  // REJECTED markers should increment.
  const instructThenApprove = sessionWith({
    '01-a/group-review.md':
      '# Group review\n\nREJECT if any of: missing tests, broken API.\n\n**Verdict: APPROVED**\n',
  });
  assert.equal(reviewCensus(instructThenApprove).rejections, 0);

  const realRound = sessionWith({
    '01-a/group-review.md':
      '# Group review\n\n**Verdict: APPROVED**\n\n## Round 1 — REJECTED\n',
  });
  assert.equal(reviewCensus(realRound).rejections, 1);
});

test('a session with no review artifacts at all counts nothing', () => {
  // The rule is stamped even when there is nothing to judge — a digest line
  // with counts of zero still needs to say which classifier produced them.
  // `finalReviewEvidence: 'none'` says the same thing about the verdict: there
  // was no review to grade, which is not a host reading that found no reviewer.
  const empty = {
    total: 0,
    independent: 0,
    selfChecks: 0,
    rejections: 0,
    finalReview: null,
    finalReviewEvidence: 'none',
    stoppedByOperator: false,
    rule: CENSUS_RULE,
  };
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

/**
 * A host-evidence answer of the shape `reviewEvidence` returns.
 *
 * `seen` and `prescribed` default to the number of dispatches in `units`, so a
 * fixture cannot quietly contradict itself — a hand-typed tally that disagrees
 * with the units it is meant to describe would test a state the reader never
 * produces. Pass them explicitly only when the point of the test *is* that they
 * differ from the units (the adoption gate below).
 *
 * `maxRequests` is not optional here even though it reads like a detail: it is
 * the count the floor is applied to, and a bucket without one is a bucket
 * `reviewEvidence` has never emitted. Leaving it off is how a dozen fixtures in
 * this file came to describe a shape the reader cannot produce — seven of them
 * asserting a host verdict on it, which they only ever got because
 * `undefined < FINAL_REVIEW_REQUEST_FLOOR` is `false`. The deliberately
 * malformed buckets below are the exception and say so.
 *
 * `partial` defaults to `false` for the same reason the tallies are derived:
 * `reviewEvidence` writes it on every answer it returns, available or not, so a
 * fixture that simply omitted it would describe a shape that reader no longer
 * emits. A test that wants the *pre-flag* shape — an evidence object frozen or
 * written before the flag existed — deletes the field by hand and says so.
 *
 * @param {{ units?: Record<string, {dispatched: number, stopped: number, requests: number,
 *     maxRequests: number}>,
 *   seen?: number, prescribed?: number, available?: boolean, partial?: boolean,
 *   reason?: string }} [spec]
 */
function evidence(spec = {}) {
  const units = spec.units ?? {};
  // Tolerant of a deliberately malformed bucket, which the tallies are always
  // passed explicitly alongside anyway.
  const dispatches = Object.values(units).reduce((n, u) => n + (Number(u?.dispatched) || 0), 0);
  const answer = {
    available: spec.available ?? true,
    units,
    seen: spec.seen ?? dispatches,
    prescribed: spec.prescribed ?? dispatches,
    partial: spec.partial ?? false,
  };
  if (spec.reason !== undefined) answer.reason = spec.reason;
  return answer;
}

test('host evidence decides the final review and the prose is not consulted', () => {
  // The whole point of the change: the review file is written by the party
  // being judged. Both fixtures are built so the prose rule ALONE returns the
  // opposite verdict — asserted here off the fixture rather than assumed — so
  // either half goes red the moment the prose is consulted on the host path.
  const dispatched = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  assert.equal(reviewCensus(dispatched).finalReview, 'self', 'fixture: prose alone says self');

  const measured = reviewCensus(dispatched, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 12, maxRequests: 12 } },
    }),
  });
  assert.equal(measured.finalReview, 'independent');
  assert.equal(measured.finalReviewEvidence, 'host');

  const claimed = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(
    reviewCensus(claimed).finalReview,
    'independent',
    'fixture: prose alone says independent',
  );

  const refuted = reviewCensus(claimed, {
    evidence: evidence({ units: { 'group-01': { dispatched: 1, stopped: 0, requests: 46 } } }),
  });
  assert.equal(refuted.finalReview, 'self');
  assert.equal(refuted.finalReviewEvidence, 'host');
});

test('with no evidence passed the verdict is the prose rule, graded inferred', () => {
  // Five of the six callers do not pass evidence today, and a session on a host
  // that writes no sidecars never will. Both must behave exactly as 0.3.28 did.
  for (const body of [
    'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n',
    'Reviewer: coordinator — self-check\n\nAPPROVED\n',
  ]) {
    const dir = sessionWith({}, body);
    const census = reviewCensus(dir);
    assert.equal(census.finalReviewEvidence, 'inferred', body.split('\n')[0]);
    assert.deepEqual(reviewCensus(dir, {}), census, 'an options object without evidence');
    assert.deepEqual(reviewCensus(dir, { evidence: null }), census, 'a null evidence');
  }
});

test('no final review file is evidence none, whatever the host recorded', () => {
  // A dispatched reviewer that wrote nothing is not a review. `finalReview`
  // stays null — the done gate refuses on null, which is correct here — and the
  // grade says there was nothing to grade rather than claiming a host reading.
  const dir = sessionWith({ '01-a/group-review.md': 'APPROVED\n' });
  const census = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 12, maxRequests: 12 } },
    }),
  });
  assert.equal(census.finalReview, null, 'absent is not the same as self');
  assert.equal(census.finalReviewEvidence, 'none');
});

test('the adoption gate reads four states, and only two of them are a host verdict', () => {
  // Measured on the real corpus (the count lives in review-census.mjs): plenty
  // of dispatches are review-shaped and almost none carries the label. Reading "no prescribed
  // dispatch" as "no reviewer ran" would mark nearly every existing session
  // self-reviewed and refuse it at the money/auth gate. Each row below is given
  // a fixture whose prose says the OPPOSITE of the expected host verdict, so no
  // row can pass by accidentally falling through to the prose rule.
  const selfProse = sessionWith({}, 'Reviewer: coordinator — self-check\n\nAPPROVED\n');
  const claimProse = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(reviewCensus(selfProse).finalReview, 'self', 'fixture: prose alone says self');
  assert.equal(
    reviewCensus(claimProse).finalReview,
    'independent',
    'fixture: prose alone says independent',
  );

  // 1. prescribed > 0 and the unit is present — follow the unit.
  const followed = reviewCensus(selfProse, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 12, maxRequests: 12 } },
    }),
  });
  assert.equal(followed.finalReview, 'independent');
  assert.equal(followed.finalReviewEvidence, 'host');

  // 2. prescribed > 0 and the unit is absent — the convention IS in use here,
  //    so the final reviewer's absence from the table means something.
  const absent = reviewCensus(claimProse, {
    evidence: evidence({ units: { 'group-01': { dispatched: 2, stopped: 0, requests: 46 } } }),
  });
  assert.equal(absent.finalReview, 'self');
  assert.equal(absent.finalReviewEvidence, 'host');

  // 3. seen > 0, prescribed === 0 — nobody in this repo labels their dispatches,
  //    so the host has no answer to give. Whatever the prose rule returns,
  //    field for field, in both directions.
  for (const dir of [selfProse, claimProse]) {
    const unadopted = reviewCensus(dir, {
      evidence: evidence({ units: {}, seen: 7, prescribed: 0 }),
    });
    assert.deepEqual(unadopted, reviewCensus(dir), 'exactly what the prose rule alone returns');
    assert.equal(unadopted.finalReviewEvidence, 'inferred');
  }

  // The boundary of that row: ONE unlabelled dispatch is already the convention
  // not being in use. `seen: 7` above would survive a rule that read `seen > 1`.
  const single = reviewCensus(claimProse, {
    evidence: evidence({ units: {}, seen: 1, prescribed: 0 }),
  });
  assert.deepEqual(single, reviewCensus(claimProse), 'one unlabelled dispatch is enough');

  // 4. seen === 0 — nothing identifiable was dispatched at all, which IS the
  //    host saying no reviewer ran. Same empty `units` as row 3 and the
  //    opposite verdict on the same fixture: the tallies, not the table, are
  //    what tell those two states apart.
  const nothing = reviewCensus(claimProse, { evidence: evidence({ units: {} }) });
  assert.equal(nothing.finalReview, 'self');
  assert.equal(nothing.finalReviewEvidence, 'host');
});

test('an unavailable reading never refuses on the grounds of absence alone', () => {
  // `available: false` means "I could not look", and its `units`, `seen` and
  // `prescribed` are placeholders that keep the shape uniform — not
  // measurements. A census that reads the tallies without the flag sees
  // `seen === 0`, returns `self` for every session nobody could measure, and
  // refuses correct work at the done gate. This fixture's prose says
  // independent, so that is precisely what it fails on.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');

  for (const unreadable of [
    evidence({ available: false, reason: 'no host session bound to this Forge session' }),
    // `reviewEvidence` never fills these in on an unavailable answer; the row
    // is here to pin the ORDER of the reads — the flag before the table.
    evidence({
      available: false,
      units: { final: { dispatched: 1, stopped: 1, requests: 3, maxRequests: 0 } },
      reason: 'placeholders are not measurements',
    }),
    // `available` must be exactly `true`, not merely truthy and not merely
    // present. A reader that is not this reader — a future host adapter, a
    // JSON round-trip — has not earned a gate decision by writing a string.
    { available: 'true', units: {}, seen: 0, prescribed: 0 },
    { available: 1, units: {}, seen: 0, prescribed: 0 },
    { units: {}, seen: 0, prescribed: 0 },
  ]) {
    const census = reviewCensus(dir, { evidence: unreadable });
    assert.deepEqual(census, bare, 'identical to passing no evidence at all');
    assert.equal(census.finalReviewEvidence, 'inferred');
  }
});

test('an evidence object the census cannot read falls back to prose and never throws', () => {
  // Group 3.1 hands `reviewEvidence`'s answer straight through, inside
  // `forge phase done`, where telemetry must never block a transition. A shape
  // this cannot read is a shape it cannot decide on: absent tallies would make
  // `seen > 0` false and read as "nothing was dispatched" — an absence turned
  // into a negative — and an absent table would throw on the way there.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');

  for (const malformed of [
    { available: true },
    { available: true, units: {} },
    { available: true, seen: 'two', prescribed: 0, units: {} },
    { available: true, seen: 2, prescribed: 1, units: null },
    'available',
    42,
  ]) {
    const census = reviewCensus(dir, { evidence: malformed });
    assert.deepEqual(census, bare, JSON.stringify(malformed));
  }
});

test('a final bucket that cannot be read is not a reviewer that did not run', () => {
  // A record for the unit is PRESENT and unreadable. That is "I cannot tell",
  // and answering `self` on host grade turns it into "nobody reviewed" — the
  // same collapse group 1 closed three times one layer up, and a confident
  // refusal at the money/auth gate built on an absence. `reviewEvidence` cannot
  // emit these today, but 3.2 round-trips the verdict through JSON and the
  // module's own JSDoc promises a shape it cannot read lands on prose.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');

  for (const bucket of [
    '2',
    2,
    null,
    ['dispatched'],
    { dispatched: '2', stopped: 0 },
    { dispatched: null, stopped: 0 },
    { dispatched: 1, stopped: '1' }, // an unreadable STOP is equally unreadable
    { stopped: 1 },
    {},
    // AND AN UNREADABLE SUBSTANCE COUNT. This is the shape every bucket
    // built before the floor existed has: two readable tallies and no
    // `maxRequests` at all. `undefined < FINAL_REVIEW_REQUEST_FLOOR` is `false`,
    // so without this guard such a bucket sails past the floor and grades
    // `independent` on `host` — a missing measurement read as "large enough",
    // which is the absence-into-a-positive collapse the module argues against
    // everywhere else.
    { dispatched: 1, stopped: 0, requests: 12 },
    { dispatched: 1, stopped: 0, requests: 12, maxRequests: '12' },
    // `null` is what a JSON round-trip makes of a count that was not finite, so
    // it is the shape 3.2 can actually hand back. It is the mild one — `null <
    // 5` is true, so it fell to prose even before the guard — and it is listed
    // for the shape rather than for the mutant.
    { dispatched: 2, stopped: 0, requests: 46, maxRequests: null },
    // Unreadable before the stop is read, not after: a stopped-only bucket
    // whose substance count is junk is a bucket this reader never emitted, and
    // answering `self` from two of its three fields is deciding on a shape we
    // cannot vouch for. Prose is the side that cannot refuse correct work.
    { dispatched: 1, stopped: 1, requests: 40, maxRequests: '0' },
  ]) {
    const census = reviewCensus(dir, {
      evidence: evidence({ units: { final: bucket }, seen: 2, prescribed: 2 }),
    });
    assert.deepEqual(census, bare, `units.final = ${JSON.stringify(bucket)}`);
  }

  // The boundary of that guard: a bucket whose numbers ARE readable still
  // decides, including the zero the producer never writes.
  const zero = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 0, stopped: 0, requests: 0, maxRequests: 0 } },
      seen: 2,
      prescribed: 2,
    }),
  });
  assert.equal(zero.finalReview, 'self');
  assert.equal(zero.finalReviewEvidence, 'host');
});

test('a declined reviewer is surfaced even when it wrote no review file', () => {
  // The likeliest instantiation of the spec's own scenario: the operator stops
  // the reviewer BEFORE it writes anything. The host verdict used to be
  // computed inside the review-file loop, so exactly that case reported
  // `stoppedByOperator: false` — and after 3.1 that false freezes into
  // session.json and the digest for a session where the operator demonstrably
  // declined. `ledger.mjs` already documents that evaporation for the waiver.
  const dir = sessionWith({});
  assert.equal(fs.existsSync(path.join(dir, 'reviews', 'final-review.md')), false, 'fixture: no file');

  const census = reviewCensus(dir, {
    evidence: evidence({
      // Every dispatch stopped, so the collector's own rule reports no
      // substance at all: a stopped record never contributes its requests to
      // the maximum, however many it burnt on its way to being killed.
      units: { final: { dispatched: 1, stopped: 1, requests: 40, maxRequests: 0 } },
    }),
  });
  assert.equal(census.stoppedByOperator, true, 'the fact is the host record, not the file');
  assert.equal(census.finalReview, null, 'no file is still no review');
  assert.equal(census.finalReviewEvidence, 'none', 'and nothing to grade');
  assert.equal('finalReviewWaived' in census, false);

  // Not stopped, no file: the flag stays false because nothing was stopped.
  const quiet = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 40, maxRequests: 40 } },
    }),
  });
  assert.equal(quiet.stoppedByOperator, false);
});

test('host evidence never reaches the per-group counts', () => {
  // A deliberate scope boundary stated in the module header and held by nothing
  // until now: every other evidence-carrying fixture has an empty `tasks/`, so
  // wiring the host verdict into the per-artifact loop would have gone
  // unnoticed. Those counts are worth ~2 scorecard points and widening the
  // evidence path to them would put every review artifact behind a gate call.
  const dir = sessionWith(
    {
      '01-a/group-review.md': 'Reviewer: coordinator — self-check\n\nAPPROVED\n',
      '02-b/group-review.md': 'Reviewer: claude-opus-5 (group-reviewer)\n\nAPPROVED\n',
    },
    'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n',
  );
  const bare = reviewCensus(dir);
  assert.equal(bare.selfChecks, 1, 'fixture: prose alone counts one self-check');
  assert.equal(bare.independent, 1, 'fixture: prose alone counts one independent');
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says the final review is self');

  const census = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 12, maxRequests: 12 } },
    }),
  });
  assert.equal(census.finalReview, 'independent', 'the final verdict does follow the host');
  assert.equal(census.total, bare.total);
  assert.equal(census.selfChecks, bare.selfChecks, 'per-group counts stay on prose');
  assert.equal(census.independent, bare.independent, 'per-group counts stay on prose');
});

test('a stopped dispatch is reported, and no waiver is applied on the operator behalf', () => {
  // The host's own record of an operator declining a reviewer: measured, 5 of
  // Most metas carry it and a couple of those are review dispatches. A unit whose
  // only dispatch was stopped is a reviewer that did not finish.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(reviewCensus(dir).finalReview, 'independent', 'fixture: prose alone says independent');
  const sessionFile = path.join(dir, 'session.json');
  fs.writeFileSync(sessionFile, '{"id":"s1","phase":"implement"}\n', 'utf8');
  const before = fs.readFileSync(sessionFile, 'utf8');

  const declined = reviewCensus(dir, {
    evidence: evidence({
      // Every dispatch stopped, so the collector's own rule reports no
      // substance at all: a stopped record never contributes its requests to
      // the maximum, however many it burnt on its way to being killed.
      units: { final: { dispatched: 1, stopped: 1, requests: 40, maxRequests: 0 } },
    }),
  });
  assert.equal(declined.finalReview, 'self');
  assert.equal(declined.finalReviewEvidence, 'host');
  assert.equal(declined.stoppedByOperator, true);

  // Declining a reviewer is the operator's decision to record. Forge surfaces
  // the fact and names the remedy; it does not waive on their behalf.
  assert.equal('finalReviewWaived' in declined, false);
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), before, 'the census wrote to the session');

  const finished = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 40, maxRequests: 40 } },
    }),
  });
  assert.equal(finished.stoppedByOperator, false, 'nothing was stopped');
});

test('a stopped dispatch followed by a completed one is independent, stop still reported', () => {
  // The brief left this as `assumed — verify`. Verified against the real corpus
  // on this machine: of the 20 repeated dispatch descriptions, one is a stopped
  // run followed by a completed re-run, so a unit carrying both is a shape that
  // occurs, not a hypothetical. A reviewer did run to completion, so the
  // verdict follows the completed dispatch — and the stop is still surfaced,
  // because it is a fact the host recorded, not the verdict's cause.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\nAPPROVED\n');
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');

  const retried = reviewCensus(dir, {
    evidence: evidence({
      // THE 61 DECOMPOSES, and how it decomposes is the whole test. A killed
      // run that had made 1 request, then a re-run that made 60: `requests` is
      // the pair's sum and `maxRequests` is the completed dispatch's own count,
      // because the collector never lets a stopped record contribute a maximum.
      // 60 is deliberately well clear of the floor — the re-run is the reviewer
      // that did the work, and this test exists to prove the verdict follows
      // it. Putting a below-floor number here would turn this into the
      // stopped-vouches-for-a-token case below and delete the only coverage
      // there is of the stopped-beside-completed branch reaching `independent`.
      units: { final: { dispatched: 2, stopped: 1, requests: 61, maxRequests: 60 } },
    }),
  });
  assert.equal(retried.finalReview, 'independent');
  assert.equal(retried.finalReviewEvidence, 'host');
  assert.equal(retried.stoppedByOperator, true);

  // Both stopped is the other edge: no reviewer finished.
  const bothStopped = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 2, stopped: 2, requests: 8, maxRequests: 0 } },
    }),
  });
  assert.equal(bothStopped.finalReview, 'self');
  assert.equal(bothStopped.stoppedByOperator, true);
});

test('a token dispatch does not certify the review — the prose answers instead', () => {
  // F33, reproduced. A throwaway subagent dispatched as `forge-review final
  // <sessionId>` — one request, reviewing nothing — is a dispatch the operator
  // did not stop, so the census answered `independent` on `host` grade and the
  // money/auth done gate let the session through, against a review file saying
  // in plain English that no subagent read the change. Dispatching a subagent
  // is cheap; what the floor makes expensive is dispatching one that runs.
  //
  // The `self` here must come from the PROSE and not from the floor — the
  // floor's own answer is `null`, "the host cannot say". So the fixture is
  // graded by the prose rule alone first, and the whole census is then compared
  // field for field against that reading: this test cannot pass by the floor
  // inventing a verdict of its own, and goes red if the floor ever refuses.
  const dir = sessionWith(
    {},
    '# Final review\n\n' +
      '**Reviewer:** the coordinator. No final-reviewer subagent read this change;\n' +
      'the dispatch below is a stub.\n\n' +
      '**Verdict: APPROVED**\n',
  );
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');
  assert.equal(bare.finalReviewEvidence, 'inferred');

  const forged = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: 1, maxRequests: 1 } },
    }),
  });
  assert.equal(forged.finalReview, 'self');
  assert.equal(forged.finalReviewEvidence, 'inferred', 'the host has no answer to give');
  assert.deepEqual(forged, bare, 'exactly what the prose rule alone returns');
});

test('ten token dispatches are not one review — the floor reads the busiest, not the sum', () => {
  // THE FIRST EVASION, and the reason the floor is applied to `maxRequests`.
  // Dispatching a subagent is cheap, so the cheapest way past a floor read off
  // `requests` is ten stubs instead of one: the sum clears any threshold while
  // no single dispatch read anything. A sum can be assembled out of pieces that
  // each reviewed nothing; a maximum cannot — some ONE dispatch has to have
  // done the work.
  //
  // THIS IS ALSO THE ONLY SHAPE THAT CAN TELL THE TWO FIELDS APART. With one
  // unstopped dispatch `requests === maxRequests` identically, so substituting
  // `bucket.requests` into the floor passed every other test in this file —
  // measured, not assumed, before this test was written. It needs
  // `requests >= floor > maxRequests`, which needs more than one dispatch.
  const tokens = Array.from({ length: 10 }, () => 1); // ten dispatches, one request each
  const unit = {
    dispatched: tokens.length,
    stopped: 0,
    requests: tokens.reduce((sum, n) => sum + n, 0),
    maxRequests: Math.max(...tokens),
  };
  // Read off the fixture rather than typed beside it. A hand-written expected
  // number that stops straddling the floor leaves a test that passes and has
  // stopped testing; these three say so out loud instead.
  assert.ok(unit.stopped < unit.dispatched, 'fixture: reaches the independent branch at all');
  assert.ok(
    unit.requests >= FINAL_REVIEW_REQUEST_FLOOR,
    `fixture: the sum clears the floor (${unit.requests})`,
  );
  assert.ok(
    unit.maxRequests < FINAL_REVIEW_REQUEST_FLOOR,
    `fixture: no single dispatch does (${unit.maxRequests})`,
  );

  const dir = sessionWith(
    {},
    '# Final review\n\n' +
      '**Reviewer:** the coordinator. Ten stub dispatches, none of which read the\n' +
      'change.\n\n' +
      '**Verdict: APPROVED**\n',
  );
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const swarm = reviewCensus(dir, { evidence: evidence({ units: { final: unit } }) });
  assert.equal(swarm.finalReview, 'self');
  assert.equal(swarm.finalReviewEvidence, 'inferred', 'the host has no answer to give');
  assert.deepEqual(swarm, bare, 'exactly what the prose rule alone returns');
});

test('a stopped dispatch cannot vouch for the token one beside it', () => {
  // THE SECOND EVASION, argued for in the census comment and unproven until
  // now. The grade here is `stopped < dispatched`, so this unit does reach the
  // `independent` branch — a reviewer ran to completion, as far as the grade
  // can see. What ran was one request. The substance came from the dispatch the
  // operator KILLED, and a floor that counted it would let a review the operator
  // declined certify the stub that replaced it. `maxRequests` excludes stopped
  // records for exactly this pair, and `requests` does not.
  const dispatches = [
    // Big enough to clear the floor on its own several times over, and stopped.
    { requests: FINAL_REVIEW_REQUEST_FLOOR * 12, stopped: true },
    { requests: 1, stopped: false },
  ];
  const unit = {
    dispatched: dispatches.length,
    stopped: dispatches.filter((d) => d.stopped).length,
    requests: dispatches.reduce((sum, d) => sum + d.requests, 0),
    // The collector's own rule, restated here so the fixture is derived and not
    // declared: a stopped record never contributes to the maximum.
    maxRequests: dispatches.reduce((max, d) => (d.stopped ? max : Math.max(max, d.requests)), 0),
  };
  assert.ok(
    unit.stopped < unit.dispatched,
    'fixture: grades independent, so the FLOOR is what has to stop it',
  );
  assert.ok(
    unit.requests >= FINAL_REVIEW_REQUEST_FLOOR,
    `fixture: the pair together clears the floor (${unit.requests})`,
  );
  assert.ok(
    unit.maxRequests < FINAL_REVIEW_REQUEST_FLOOR,
    `fixture: the dispatch that actually RAN does not (${unit.maxRequests})`,
  );

  const dir = sessionWith(
    {},
    '# Final review\n\n' +
      '**Reviewer:** the coordinator. The dispatched reviewer was declined; the\n' +
      'second dispatch is a stub that read nothing.\n\n' +
      '**Verdict: APPROVED**\n',
  );
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const vouched = reviewCensus(dir, { evidence: evidence({ units: { final: unit } }) });
  assert.equal(vouched.finalReview, 'self');
  assert.equal(vouched.finalReviewEvidence, 'inferred', 'the host has no answer to give');
  assert.deepEqual(vouched, bare, 'exactly what the prose rule alone returns');
});

test('the floor is a boundary — a dispatch that meets it still certifies the review', () => {
  // Both edges, read off the constant rather than typed as a number: a count AT
  // the floor is enough, one below it is not. Nothing else in this file
  // exercises the comparison itself, so without this a `<=` for `<` — or a
  // floor moved to any other value — is invisible. The fixture's prose says
  // `self`, so the row that expects `independent` cannot pass by falling
  // through to it.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\nAPPROVED\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  /** One unstopped dispatch that made `n` requests — so `requests` is `n` too. */
  const unit = (n) => ({ units: { final: { dispatched: 1, stopped: 0, requests: n, maxRequests: n } } });

  const met = reviewCensus(dir, { evidence: evidence(unit(FINAL_REVIEW_REQUEST_FLOOR)) });
  assert.equal(met.finalReview, 'independent', 'at the floor the host still decides');
  assert.equal(met.finalReviewEvidence, 'host');

  const under = reviewCensus(dir, { evidence: evidence(unit(FINAL_REVIEW_REQUEST_FLOOR - 1)) });
  assert.deepEqual(under, bare, 'one request short and there is no host answer at all');
});

test('the floor is high enough to have rejected the alternatives the design rejected', () => {
  // THE VALUE, NOT JUST THE COMPARISON. Every other test here reads the floor
  // off the constant, which is right — a bare `=== 5` is a change-detector that
  // fails on any edit whether or not behaviour changed. But it leaves the value
  // itself pinned by nothing: the final reviewer measured that a floor of 2, 3
  // or 4 passes this entire suite, so a silent downgrade to the alternative
  // `design.md` argues against ships green.
  //
  // Pinned behaviourally instead. `design.md` rejects 2 because "pad to 3 and
  // walk through": a forger who knows a floor of 2 exists needs three requests
  // to beat it, which is still a dispatch that reviewed nothing. So the rule
  // this asserts is that a dispatch of 4 requests — comfortably padded, and a
  // quarter of the smallest review in the corpus — does not certify. That holds
  // for any floor of 5 or more and fails for every value the design rejected as
  // too low, without naming a number.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\nAPPROVED\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const padded = 4;
  assert.ok(
    padded < FINAL_REVIEW_REQUEST_FLOOR,
    `the floor is ${FINAL_REVIEW_REQUEST_FLOOR}, at or below the padded-forgery count this test ` +
      'exists to reject — see design.md, which rejected 2 for exactly this reason',
  );
  const result = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests: padded, maxRequests: padded } },
    }),
  });
  assert.deepEqual(result, bare, 'a padded token dispatch is still no host answer');
});

test('THE CONTROL — a real review still outranks self-check prose, at every observed size', () => {
  // THIS IS THE TEST THAT GOES RED IF THE FLOOR STARTS EATING REAL WORK, and
  // that is the direction this module has been reverted for twice: 0.3.24's
  // fail-closed attribution rule and the `contract` narrowing both refused
  // sessions whose independent review already existed, at the money/auth done
  // gate. Every other floor test in this file asks whether a forgery is
  // stopped. Only this one asks whether genuine work still gets through, and it
  // is the more expensive question to get wrong: a flattered score costs a
  // number, a refused transition costs the operator their work.
  //
  // The counts are the measured corpus behind the constant — all 24
  // `forge-review` dispatches on this machine, 2026-07-30: minimum 15 requests,
  // median 55, maximum 173, none below 15. The minimum is the one that matters;
  // it is the smallest real review anyone has run here, and it is the first
  // thing a raised floor would decline. If a future change moves the floor
  // above it, this test says so before the gate does.
  //
  // The prose is a self-check, so nothing here can pass by falling through to
  // it: the host verdict and the prose verdict disagree in every row.
  const observed = { minimum: 15, median: 55, maximum: 173 };
  const dir = sessionWith(
    {},
    '# Final review\n\n' +
      'Reviewer: coordinator — self-check of the whole change.\n\n' +
      '**Verdict: APPROVED**\n',
  );
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');

  for (const [name, requests] of Object.entries(observed)) {
    assert.ok(
      requests > FINAL_REVIEW_REQUEST_FLOOR,
      `the floor has risen past the corpus ${name} of ${requests} — re-measure it (F11)`,
    );
    const real = reviewCensus(dir, {
      evidence: evidence({
        units: { final: { dispatched: 1, stopped: 0, requests, maxRequests: requests } },
      }),
    });
    assert.equal(
      real.finalReview,
      'independent',
      `corpus ${name}: ${requests} requests is a review and must still certify`,
    );
    assert.equal(real.finalReviewEvidence, 'host', `corpus ${name}: must stay a host reading`);
    assert.equal(real.stoppedByOperator, false, `corpus ${name}: nothing was stopped`);
  }
});

test("the operator's refusal outranks the floor — a stopped-only unit is still self", () => {
  // A unit whose every dispatch was stopped reports `maxRequests: 0` by the
  // collector's own rule: a stopped record never contributes its substance.
  // Applying the floor to that zero would route the operator's recorded refusal
  // to the prose of the file it contradicts — and this fixture's prose claims
  // an outside reader, which is exactly what such a session's file would say.
  // The refusal is a measurement, so it keeps `host` grade and the flag.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(
    reviewCensus(dir).finalReview,
    'independent',
    'fixture: prose alone says independent',
  );

  const declined = reviewCensus(dir, {
    evidence: evidence({ units: { final: { dispatched: 1, stopped: 1, requests: 40, maxRequests: 0 } } }),
  });
  assert.equal(declined.finalReview, 'self');
  assert.equal(declined.finalReviewEvidence, 'host', 'measured, not handed back to the prose');
  assert.equal(declined.stoppedByOperator, true);
});

test('the census stamps which rule produced its verdict', () => {
  // Four classifiers have written review verdicts into sessions.jsonl in one
  // day, and nothing recorded which. fleet-report sums `independent` across
  // projects regardless, so a cross-project total silently mixes verdicts that
  // were produced by incompatible rules.
  const census = reviewCensus(sessionWith({ '01-a/group-review.md': 'APPROVED\n' }));
  assert.equal(typeof census.rule, 'number');
  assert.ok(Number.isInteger(census.rule) && census.rule > 0, `got ${census.rule}`);
  assert.equal(census.rule, CENSUS_RULE);
});

test("a pace skip is not an outside reader — Forge's own SKIPPED string counts as a self-check", () => {
  // I2, from the final review. `phases/review.md` prescribes writing
  // `SKIPPED (pace=…)` into `final-review.md` when pace skips the final review
  // on a change that is not high-risk. The recognised list carried
  // `APPROVED (pace` but not `SKIPPED (pace`, so a file whose entire content
  // records that *nobody read the change* was classified `independent`: +2
  // review points, no 29-point cap, and a permanent `{independent, inferred}`
  // line in `sessions.jsonl` and the cross-project totals.
  //
  // Not a gate escape — the instruction is conditioned on the session not being
  // high-risk, and the gate uses the same predicate — but the durable ledger
  // recorded the opposite of what happened, which is what the ledger is for.
  for (const body of [
    'SKIPPED (pace=brisk)\n',
    '# Final review\n\nSKIPPED (pace=lite) — final review not required at this pace.\n',
  ]) {
    const dir = sessionWith({}, body);
    assert.equal(reviewCensus(dir).finalReview, 'self', body.split('\n')[0]);
  }

  // And the string the pace table actually renders, verbatim from review.md.
  const dir = sessionWith({}, 'SKIPPED (pace=standard)\n');
  assert.notEqual(reviewCensus(dir).finalReview, 'independent');
});

// ---------------------------------------------------------------------------
// The dispatch stamp — the `recorded` grade.
//
// Written with the real `writeStamp` from `review-stamp.mjs`, never with
// hand-rolled JSON: the whole reason that module exists is that the writer and
// the reader must not drift, and a test that hand-writes the document tests a
// shape nothing produces. The one exception is the malformed-file test below,
// where the point IS a document `writeStamp` would never emit.
// ---------------------------------------------------------------------------

/**
 * Stamp a dispatch for the session that owns `dir`, as `forge review-label`
 * does. The session id defaults to the directory's own basename — the census
 * requires that match, so a test wanting a foreign stamp passes it explicitly.
 */
function stampDispatch(dir, { unit = 'final', sessionId = path.basename(dir) } = {}) {
  const written = writeStamp(dir, {
    unit,
    label: `forge-review ${unit} ${sessionId}`,
    sessionId,
  });
  assert.equal(written.ok, true, `fixture: the stamp was written (${written.reason ?? ''})`);
  return written;
}

test('a dispatch stamp decides the final review when the host cannot answer', () => {
  // The doctrine: the stamp substitutes for a record the host lost, never for
  // work the reviewer didn't do. Here nothing was passed at all — the state
  // every caller was in before group 3 wired evidence through, and the state a
  // resumed session whose transcript has been pruned lands in for good.
  //
  // The prose is a self-check, and it must NOT be read: this is the same pin
  // the host path carries, so a lazy implementation that consults the file and
  // then discards the reading goes red here rather than passing quietly.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');
  assert.equal(reviewCensus(dir).finalReviewEvidence, 'inferred', 'fixture: and grades inferred');

  stampDispatch(dir);
  const census = reviewCensus(dir);
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
  // A measurement only under `host`. Nothing here recorded a stop, and the
  // stamp is not the kind of record that could.
  assert.equal(census.stoppedByOperator, false);
});

test('the stamp DECIDES — it is not a tiebreak applied to the prose', () => {
  // THE DISCRIMINATING PIN, and the one every other stamp test in this file is
  // structurally incapable of being. They all pair the stamp with self-declaring
  // prose, where "the stamp decided" and "the stamp overruled a `self` reading"
  // produce the identical verdict — so an implementation that reads the prose
  // first and consults the stamp only to break a `self` tie passes all of them.
  // The task reviewer built exactly that mutant and the whole suite stayed
  // green. It is not a cosmetic difference: consulting the file at all is the
  // thing this path exists to stop, and a census that reads the prose whenever
  // the prose happens to agree is still deciding the money/auth gate off text
  // written by the party being judged.
  //
  // Neutral prose is what separates them, because the two implementations
  // disagree on the GRADE while agreeing on the verdict:
  //   deciding: the prose is never read      → independent / recorded
  //   tiebreak: the prose already said so    → independent / inferred
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');
  assert.equal(bare.finalReviewEvidence, 'inferred', 'fixture: and it is the PROSE saying it');

  stampDispatch(dir);
  const census = reviewCensus(dir);
  assert.equal(census.finalReview, 'independent');
  assert.equal(
    census.finalReviewEvidence,
    'recorded',
    'the stamp decided; a grade of `inferred` means the prose was read and merely agreed',
  );
});

test('the unit is read case-insensitively, because the writer does not normalise it', () => {
  // `forge review-label Final` is accepted — `review-label.mjs`'s own charset
  // is `/^[a-z0-9][a-z0-9._-]{0,63}$/i` — and `reviewLabel` lower-cases only
  // the LABEL it prints. `review-label-cli.mjs` hands the raw argument to
  // `writeStamp`, so the document on disk records `"unit": "Final"`.
  //
  // A case-sensitive comparison here discards that genuine stamp and hands the
  // gate back to the judged party's own file — the unsafe direction, off a
  // capital letter. `reviewEvidence` reads its units lower-cased for the same
  // reason (see `FINAL_REVIEW_UNIT`), so this restores the one comparison that
  // had drifted out of step. Normalising in the CLI would be the tidier fix and
  // is out of scope for this task; the reader must be robust regardless,
  // because stamps already on disk cannot be re-normalised.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');

  stampDispatch(dir, { unit: 'Final' });
  const stamped = JSON.parse(fs.readFileSync(path.join(dir, 'reviews', 'dispatches.json'), 'utf8'));
  assert.equal(stamped.stamps[0].unit, 'Final', 'fixture: the writer stored the raw casing');

  const census = reviewCensus(dir);
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
});

test('a group reviewer stamp does not certify the final review', () => {
  // The same scope boundary the module header states and `FINAL_REVIEW_UNIT`
  // enforces on the host path: per-group dispatches land in the same record and
  // say nothing about who read the change as a whole. A session that stamps
  // every group review and never dispatches a final reviewer must still be
  // graded by its final review's own prose.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  stampDispatch(dir, { unit: 'group-01' });
  stampDispatch(dir, { unit: 'group-02' });
  assert.deepEqual(reviewCensus(dir), bare, 'exactly what the prose rule alone returns');
});

test('a stamp naming a different session credits nothing', () => {
  // `dispatches.json` is an ordinary file under the session directory: it gets
  // copied when a session is cloned as a template, and a session id inside it
  // is the only thing that says which session it was written for. Crediting a
  // stamp that names another session would let one dispatched reviewer certify
  // every copy of the directory it ran in.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const foreign = `${path.basename(dir)}-somewhere-else`;
  assert.notEqual(foreign, path.basename(dir), 'fixture: it really is another session id');
  stampDispatch(dir, { sessionId: foreign });
  assert.deepEqual(reviewCensus(dir), bare, 'exactly what the prose rule alone returns');

  // And the boundary of that guard: the same stamp under this session's own id
  // does decide, so the test cannot pass by the census ignoring stamps outright.
  stampDispatch(dir);
  const census = reviewCensus(dir);
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
});

test('a pruned transcript no longer erases the reviewer — the stamp answers instead', () => {
  // The scenario the change exists for. `available: false` is `reviewEvidence`
  // saying "I could not look", which until now handed the verdict to a file the
  // reviewer's own subject wrote — and this fixture's file says `self-check`,
  // which is what a coordinator honestly recording their own summary writes
  // beside a dispatched reviewer's separate read. The stamp is the record the
  // host lost, so it answers, and the prose is not consulted at all.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const unreadable = evidence({
    available: false,
    reason: 'no host session bound to this Forge session',
  });
  const bare = reviewCensus(dir, { evidence: unreadable });
  assert.equal(bare.finalReview, 'self', 'fixture: without a stamp the prose still decides');
  assert.equal(bare.finalReviewEvidence, 'inferred');

  stampDispatch(dir);
  const census = reviewCensus(dir, { evidence: unreadable });
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
  assert.equal(census.stoppedByOperator, false);
});

test('the host answer outranks the stamp, in both directions', () => {
  // Precedence is host > recorded > inferred, and the stamp is the weaker
  // record on purpose: it is written when a reviewer is DISPATCHED, and only
  // the host can say what became of that dispatch. Both rows below are states
  // the stamp alone would read as `independent` / `recorded`.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  stampDispatch(dir);
  assert.equal(
    reviewCensus(dir).finalReviewEvidence,
    'recorded',
    'fixture: the stamp alone does decide this session',
  );

  // The operator declined the reviewer the stamp records dispatching. The host
  // watched that happen; the stamp was written before it did.
  const declined = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 1, requests: 40, maxRequests: 0 } },
    }),
  });
  assert.equal(declined.finalReview, 'self');
  assert.equal(declined.finalReviewEvidence, 'host');
  assert.equal(declined.stoppedByOperator, true);

  // And where the host answers `independent` the grade is still `host`, not
  // `recorded`: the two agree on the verdict, and the census must record which
  // of them measured it — that is what `CENSUS_RULE` and the grade exist for.
  const requests = FINAL_REVIEW_REQUEST_FLOOR * 3;
  assert.ok(requests >= FINAL_REVIEW_REQUEST_FLOOR, `fixture: clears the floor (${requests})`);
  const measured = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests, maxRequests: requests } },
    }),
  });
  assert.equal(measured.finalReview, 'independent');
  assert.equal(measured.finalReviewEvidence, 'host');

  // AND THE SAME POSITIVE MEASURED FROM HALF A BINDING. D4's override reaches
  // only the host's absence-negative, so a partial binding must not touch this
  // row either — the host measured a dispatch that ran, and where it can answer
  // it answers, whichever half of the conversation survived.
  //
  // Pinned because the shipped guard is `host.fromAbsence`, which today only
  // ever rides on a `self` answer: a widening to `host.fromAbsence ||
  // host.finalReview === 'independent'` survives the whole suite without this
  // row, and it would quietly re-grade a host-MEASURED positive as `recorded`.
  // The verdict would not move — which is exactly why only the grade catches
  // it, and the grade is what `CENSUS_RULE` and `fleet-report` reason about.
  const halfMeasured = reviewCensus(dir, {
    evidence: evidence({
      units: { final: { dispatched: 1, stopped: 0, requests, maxRequests: requests } },
      partial: true,
    }),
  });
  assert.equal(halfMeasured.finalReview, 'independent');
  assert.equal(
    halfMeasured.finalReviewEvidence,
    'host',
    'a partial binding does not downgrade a positive the host measured to the stamp that agrees with it',
  );
  assert.deepEqual(halfMeasured, measured, 'the flag changed nothing on a measured positive');
});

// ---------------------------------------------------------------------------
// The substance floor bounds the stamp (design D3, finding F33).
//
// `hostFinalReview` answers `null` for a well-formed `final` bucket whose
// busiest unstopped dispatch is below `FINAL_REVIEW_REQUEST_FLOOR`, and that
// `null` routes the verdict to the review file's prose deliberately: the host
// did read its record, and what it measured was a dispatch that did no work.
// The forger runs `forge review-label` too — that command is where the label
// the token subagent was dispatched with came from — so a stamp answering on
// that branch hands back the one-request `independent` that
// review-dispatch-substance killed. The stamp substitutes for a record the host
// lost, never for work the reviewer didn't do.
// ---------------------------------------------------------------------------

/**
 * Host evidence recording exactly the forged dispatch: one dispatch nobody
 * stopped, carrying too few requests to have read anything. The comparison
 * against the floor is asserted off the fixture rather than assumed, so this
 * cannot quietly stop describing a below-floor dispatch if the floor moves.
 */
function tokenBucket() {
  const bucket = { dispatched: 1, stopped: 0, requests: 1, maxRequests: 1 };
  assert.ok(
    bucket.maxRequests < FINAL_REVIEW_REQUEST_FLOOR,
    `fixture: the busiest unstopped dispatch is below the floor (${bucket.maxRequests})`,
  );
  assert.ok(
    bucket.stopped < bucket.dispatched,
    'fixture: nothing was stopped, so it is the floor answering `null` and not the stop branch answering `self`',
  );
  return bucket;
}

function tokenDispatch() {
  return evidence({ units: { final: tokenBucket() } });
}

test('a stamped token dispatch does not certify a review', () => {
  // F33's forgery with a stamp beside it: a throwaway subagent labelled
  // `forge-review final <sessionId>` that made one request and read nothing,
  // and the `forge review-label` run that printed that label leaving its stamp
  // on disk. Two records of a dispatch, neither of them a review. The host
  // measured this one and declined to certify it; the stamp must not certify it
  // instead, so the file's own prose decides — and it says in plain words that
  // nobody outside read the change.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');
  assert.equal(
    reviewCensus(dir, { evidence: tokenDispatch() }).finalReviewEvidence,
    'inferred',
    'fixture: below the floor the host does not answer',
  );

  stampDispatch(dir);
  assert.equal(
    reviewCensus(dir).finalReviewEvidence,
    'recorded',
    'fixture: the stamp alone does decide this session',
  );

  const census = reviewCensus(dir, { evidence: tokenDispatch() });
  assert.equal(census.finalReview, 'self');
  assert.equal(census.finalReviewEvidence, 'inferred', 'the stamp contributed nothing');
  assert.deepEqual(census, bare, 'exactly what the prose rule alone returns');
});

test('below the floor the stamp contributes nothing even when it agrees with the prose', () => {
  // The discriminating half. With self-declaring prose the guard and a stamp
  // that merely lost a tiebreak are indistinguishable by verdict, so this
  // fixture's prose is NEUTRAL: `independent` either way, and only the grade
  // says which record produced it. An implementation that consults the stamp
  // below the floor and simply prefers the prose when the prose says `self`
  // passes the test above and goes red here.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');
  assert.equal(bare.finalReviewEvidence, 'inferred', 'fixture: and it is the PROSE saying it');

  stampDispatch(dir);
  assert.equal(
    reviewCensus(dir).finalReviewEvidence,
    'recorded',
    'fixture: the stamp alone does decide this session',
  );

  const census = reviewCensus(dir, { evidence: tokenDispatch() });
  assert.equal(census.finalReview, 'independent');
  assert.equal(
    census.finalReviewEvidence,
    'inferred',
    'a grade of `recorded` means the stamp answered on a dispatch the host measured as empty',
  );
  assert.deepEqual(census, bare, 'exactly what the prose rule alone returns');
});

test('a bucket the host cannot read is a lost record, so the stamp still answers', () => {
  // The boundary of the guard above, and the direction it deliberately does NOT
  // take. A `final` bucket missing `maxRequests` is the exact shape
  // `hostFinalReview`'s bucket validation rejects — `reviewEvidence` writes all
  // three counts on every bucket it builds, so this is not its output — and the
  // host is then not saying the dispatch did no work, it is saying it cannot
  // read its own record. A lost record is what the stamp is for.
  //
  // Not a contradiction of the host's own "present and unreadable is not
  // absent": that block stops the host answering `self` off a shape it cannot
  // vouch for, which protects against refusing correct work; this guard stops
  // the stamp certifying a dispatch the host measured as empty, which protects
  // against certifying missing work. Different questions, same doctrine.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');

  const unvouched = [
    [
      'two readable tallies and no substance count — the shape of every bucket built before the floor existed',
      evidence({ units: { final: { dispatched: 1, stopped: 0, requests: 1 } }, seen: 1, prescribed: 1 }),
    ],
    [
      // The bucket is well-formed and below the floor, but the answer it sits
      // in is not readable, so the host never got as far as measuring it.
      'a below-floor bucket beside tallies that are not numbers',
      evidence({ units: { final: tokenBucket() }, seen: 'two', prescribed: 1 }),
    ],
    [
      // `reviewEvidence` zeroes its tallies and empties `units` when it could
      // not look, so a bucket riding along on `available: false` is not a shape
      // it emits — and after 3.2's JSON round-trip the shape stops being ours.
      // Read the flag first, exactly as `hostFinalReview` does.
      'a below-floor bucket on an answer that says it could not look',
      evidence({ available: false, units: { final: tokenBucket() }, reason: 'transcript pruned' }),
    ],
  ];

  for (const [why, unreadable] of unvouched) {
    assert.equal(
      reviewCensus(dir, { evidence: unreadable }).finalReviewEvidence,
      'inferred',
      `fixture: the host declines to answer — ${why}`,
    );
  }

  stampDispatch(dir);
  for (const [why, unreadable] of unvouched) {
    const census = reviewCensus(dir, { evidence: unreadable });
    assert.equal(census.finalReview, 'independent', why);
    assert.equal(census.finalReviewEvidence, 'recorded', why);
  }
});

test('the floor guard does not reach the session whose host simply never labelled', () => {
  // The adoption gate — `seen > 0, prescribed === 0` — is the state nearly every
  // existing session is in (adoption measured at near zero; the count lives in
  // `review-census.mjs`), and it is one of the two the stamp exists to recover.
  // `units` is empty there, because buckets are only ever built from prescribed
  // records, so there is no `final` bucket for the guard to find well-formed.
  // A guard that keyed off "evidence was passed at all", or off `available`,
  // would silently take the stamp away from the whole corpus.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const unlabelled = evidence({ units: {}, seen: 7, prescribed: 0 });
  const bare = reviewCensus(dir, { evidence: unlabelled });
  assert.equal(bare.finalReview, 'self', 'fixture: without a stamp the prose decides');
  assert.equal(bare.finalReviewEvidence, 'inferred');

  stampDispatch(dir);
  const census = reviewCensus(dir, { evidence: unlabelled });
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
});

test('a malformed stamp file is an absence, not an error', () => {
  // This runs inside `forge phase done`, where telemetry must never block a
  // transition — `readStamps` is built to answer `[]` for anything it cannot
  // make sense of, and this is the census half of that contract: a truncated
  // or half-written `dispatches.json` reads exactly like "no reviewer was
  // stamped" and the prose decides, rather than throwing through the gate.
  //
  // Hand-written on purpose, unlike every other stamp fixture here: a document
  // `writeStamp` would never emit is the entire point.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const file = path.join(dir, 'reviews', 'dispatches.json');
  for (const malformed of [
    '{"version":1,"stamps":[{"unit":"final","label":"forge-rev', // truncated mid-write
    'not json at all\n',
    '[]\n',
    '{"version":1}\n',
  ]) {
    fs.writeFileSync(file, malformed, 'utf8');
    let census;
    assert.doesNotThrow(() => {
      census = reviewCensus(dir);
    }, malformed.slice(0, 40));
    assert.deepEqual(census, bare, `${malformed.slice(0, 40)}: the prose rule alone`);
  }
});

test('a stamp does not conjure a review — no file is still no review', () => {
  // A reviewer that was dispatched and wrote nothing is not a review, and the
  // stamp records only the dispatch. `finalReview` stays null (the done gate
  // refuses on null, which is correct here) and the grade says there was
  // nothing to grade rather than claiming a record of one.
  //
  // Structural, not incidental: the stamp is consulted inside the loop over
  // the review files, so the missing-file `continue` reaches this first. The
  // host verdict is deliberately computed OUTSIDE that loop — a stopped
  // dispatch is a fact about the session — and copying that placement for the
  // stamp is exactly what this test forbids.
  const dir = sessionWith({ '01-a/group-review.md': 'APPROVED\n' });
  assert.equal(
    fs.existsSync(path.join(dir, 'reviews', 'final-review.md')),
    false,
    'fixture: no final review file',
  );

  stampDispatch(dir);
  const census = reviewCensus(dir);
  assert.equal(census.finalReview, null, 'absent is not the same as independent');
  assert.equal(census.finalReviewEvidence, 'none');
});

test('the recorded grade is a new classifier, so it carries a new rule number', () => {
  // The number exists because four classifiers wrote verdicts into
  // `sessions.jsonl` in one day and nothing recorded which, so `fleet-report`
  // could not tell which totals were comparable. A rule-4 `independent` was
  // either a host reading or a prose one; this change adds a third way to reach
  // that same word, off a record no earlier rule could see. Totals that mix
  // them are mixing measurements, so the rule has to move with the classifier
  // — the one thing the field is for.
  const LAST_RULE_WITHOUT_THE_STAMP = 4;
  assert.ok(
    CENSUS_RULE > LAST_RULE_WITHOUT_THE_STAMP,
    `the stamp is a new classifier and CENSUS_RULE is still ${CENSUS_RULE}`,
  );

  // And the verdict it produces carries that number, not just the export.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  stampDispatch(dir);
  const census = reviewCensus(dir);
  assert.equal(census.finalReviewEvidence, 'recorded', 'fixture: the stamp decided this one');
  assert.equal(census.rule, CENSUS_RULE);
});

// ---------------------------------------------------------------------------
// The partial binding bounds the host's absence-negative (design D4).
//
// `reviewEvidence` answers `available: true` from the surviving half of a
// binding whose other host transcript has been pruned — deliberately, because
// refusing instead would make every resumed session unmeasurable within days.
// An absent `final` unit read from that half then reaches `hostFinalReview` as
// the "one genuine negative", indistinguishable from one measured over the
// whole conversation, and the gate refuses a session whose reviewer ran in the
// pruned half. That is the F58 residual 3.2's reviewer reproduced. Task 4.1
// gave the answer a `partial` flag; these tests pin what this module does with
// it, and — as much — what it does NOT.
// ---------------------------------------------------------------------------

/**
 * The reproduced scenario's host answer: measured from half a binding, the
 * convention in use (a prescribed `group-01` dispatch defeats the adoption
 * gate, so `prescribed > 0`), and no `final` unit in the table.
 *
 * The group dispatch clears the substance floor on purpose. It is not the unit
 * under judgement, so the floor never looks at it — but a fixture describing a
 * token dispatch would be describing a different scenario than the one this
 * section is named for.
 */
function halfReadBinding(spec = {}) {
  const requests = FINAL_REVIEW_REQUEST_FLOOR * 2;
  const answer = evidence({
    units: { 'group-01': { dispatched: 1, stopped: 0, requests, maxRequests: requests } },
    partial: true,
    ...spec,
  });
  assert.equal(answer.available, true, 'fixture: the surviving half still answers');
  assert.ok(answer.prescribed > 0, `fixture: the convention is in use (${answer.prescribed})`);
  assert.equal(answer.units.final, undefined, 'fixture: no final unit in the table');
  return answer;
}

test('an absence measured from a partial binding does not erase a stamped reviewer', () => {
  // D4. The host's `bucket === undefined` negative is a confident `self` built
  // on an absence — and here the absence was read from half a conversation, so
  // it is not a complete measurement. The stamp is the record the pruned half
  // left behind, and it decides.
  //
  // The prose says `self-check`, so a lazy implementation that falls through to
  // the file answers `self`/`inferred` and goes red rather than passing on the
  // right verdict for the wrong reason.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  assert.equal(reviewCensus(dir).finalReview, 'self', 'fixture: prose alone says self');

  const halfRead = halfReadBinding();
  const bare = reviewCensus(dir, { evidence: halfRead });
  assert.equal(bare.finalReview, 'self', 'fixture: without a stamp the host still answers self');
  assert.equal(bare.finalReviewEvidence, 'host', 'fixture: and it is the HOST answering');

  stampDispatch(dir);
  const census = reviewCensus(dir, { evidence: halfRead });
  assert.equal(census.finalReview, 'independent');
  assert.equal(census.finalReviewEvidence, 'recorded');
  // Nothing measured a stop here, and the stamp is not the kind of record that
  // could: the host's absence-negative carries `false` and the override leaves
  // it exactly as it found it.
  assert.equal(census.stoppedByOperator, false);
});

test('the partial flag alone decides nothing — without a stamp the absence still answers', () => {
  // The regression net for the override's first conjunct read from the other
  // side. A partial binding is not itself a reason to doubt the host: with no
  // stamp on disk there is no second record to prefer, and the verdict must be
  // byte-for-byte the one a complete binding produces. An implementation that
  // routed partial absences to the prose "to be safe" would hand this session's
  // gate back to the file under suspicion — and this fixture's prose says the
  // opposite of the host, so it would go red rather than quietly agreeing.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(reviewCensus(dir).finalReview, 'independent', 'fixture: prose alone says independent');
  assert.equal(
    fs.existsSync(path.join(dir, 'reviews', 'dispatches.json')),
    false,
    'fixture: nothing was stamped',
  );

  const census = reviewCensus(dir, { evidence: halfReadBinding() });
  assert.equal(census.finalReview, 'self');
  assert.equal(census.finalReviewEvidence, 'host');
  assert.deepEqual(
    census,
    reviewCensus(dir, { evidence: halfReadBinding({ partial: false }) }),
    'the same absence over a complete binding — the flag changed nothing on its own',
  );
});

test('a measured stop wins even over a partial binding', () => {
  // The first boundary: absence only. Every recorded dispatch of the final unit
  // was stopped by the operator — a fact about dispatches that exist, on the
  // half of the binding that survived — and the stamp was written before any of
  // them ran. The operator's refusal is the host's record of a decision, and no
  // stamp and no pruning gives the census standing to overturn it.
  //
  // The prose reads independent, so an implementation that widened the override
  // to any partial `self` would answer `independent` here on `recorded`, and one
  // that fell through to the file would answer `independent` on `inferred`:
  // both distinguishable from the required `self`/`host`.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(reviewCensus(dir).finalReview, 'independent', 'fixture: prose alone says independent');
  stampDispatch(dir);
  assert.equal(
    reviewCensus(dir).finalReviewEvidence,
    'recorded',
    'fixture: the stamp alone does decide this session',
  );

  const stoppedBucket = { dispatched: 2, stopped: 2, requests: FINAL_REVIEW_REQUEST_FLOOR * 4, maxRequests: 0 };
  assert.ok(
    stoppedBucket.stopped >= stoppedBucket.dispatched,
    'fixture: every recorded dispatch of the unit was stopped — the measured negative',
  );
  const halfRead = evidence({ units: { final: stoppedBucket }, partial: true });
  assert.equal(halfRead.partial, true, 'fixture: and it was measured from half a binding');

  const census = reviewCensus(dir, { evidence: halfRead });
  assert.equal(census.finalReview, 'self');
  assert.equal(census.finalReviewEvidence, 'host');
  assert.equal(census.stoppedByOperator, true, 'the fact the host recorded is still reported');
});

test("a complete binding's absence stands against the stamp, and so does one that never said", () => {
  // The second boundary: partial only. The host saw the whole conversation and
  // this session's final reviewer is not in it — a label `forge review-label`
  // printed but no dispatch ever carried is not a review, and this is the
  // negative rule 5 shipped and D4 deliberately left standing.
  //
  // The second row is the same absence on an evidence object with NO `partial`
  // field at all: the shape every caller passed before task 4.1, and the shape a
  // foreign or JSON-round-tripped answer can still carry. A missing flag is not
  // a claim that the binding was partial, so it must read exactly like `false`.
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');
  assert.equal(reviewCensus(dir).finalReview, 'independent', 'fixture: prose alone says independent');
  stampDispatch(dir);
  assert.equal(
    reviewCensus(dir).finalReviewEvidence,
    'recorded',
    'fixture: the stamp alone does decide this session',
  );

  const complete = halfReadBinding({ partial: false });
  const preFlag = halfReadBinding({ partial: false });
  // Hand-deleted rather than never written: the helper mirrors what
  // `reviewEvidence` emits today, and the point of this row is the shape that
  // reader used to emit and no longer does.
  delete preFlag.partial;
  assert.equal(Object.hasOwn(preFlag, 'partial'), false, 'fixture: the field is absent, not false');

  for (const [why, answer] of [
    ['a complete binding says `partial: false`', complete],
    ['an evidence object written before the flag existed', preFlag],
  ]) {
    const census = reviewCensus(dir, { evidence: answer });
    assert.equal(census.finalReview, 'self', why);
    assert.equal(census.finalReviewEvidence, 'host', why);
    assert.equal(census.stoppedByOperator, false, why);
  }
});

test('the substance floor is untouched by the partial flag — a below-floor bucket is not an absence', () => {
  // The third boundary: D3 stands. A well-formed `final` bucket below
  // `FINAL_REVIEW_REQUEST_FLOOR` is the one `null` the host *measured* — a
  // dispatch nobody stopped that did no work — and `finalBucketWellFormed`
  // routes it to the prose so the stamp cannot hand F33's one-request forgery
  // its `independent` back. That guard reads the bucket, never the binding, and
  // a partial binding must not open a second door into it: the forger's own
  // session is resumed as often as anyone's.
  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\n**Verdict: APPROVED**\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const halfReadToken = evidence({ units: { final: tokenBucket() }, partial: true });
  assert.equal(halfReadToken.partial, true, 'fixture: measured from half a binding');
  assert.equal(
    reviewCensus(dir, { evidence: halfReadToken }).finalReviewEvidence,
    'inferred',
    'fixture: below the floor the host does not answer, partial or not',
  );

  stampDispatch(dir);
  const census = reviewCensus(dir, { evidence: halfReadToken });
  assert.equal(census.finalReview, 'self');
  assert.equal(census.finalReviewEvidence, 'inferred', 'the stamp contributed nothing');
  assert.deepEqual(census, bare, 'exactly what the prose rule alone returns');
});

// ---------------------------------------------------------------------------
// The join — a real `reviewEvidence` answer, not the hand-written `evidence()`
// literal above.
//
// Every test above this line that passes `evidence` builds it with the local
// helper: a hand-typed literal of the shape `reviewEvidence` returns. That
// pins this module's half of the contract and nothing about the join itself —
// it would keep passing even if `reviewEvidence` stopped producing
// `available: false` for a half-read binding, because no `reviewEvidence`
// ever runs in it. This fixture instead builds the on-disk host tree via the
// shared `metrics/test-host-tree.mjs` helpers (same planter as review-evidence
// / collect) and feeds `reviewEvidence`'s real return value into
// `reviewCensus`. It is the only test in the suite that would catch the two
// halves drifting apart.
// ---------------------------------------------------------------------------

const PARENT_LINE = assistantLine({ requestId: 'parent_1', at: '2026-07-28T10:00:00.000Z' });
const HOST_PROJECT = '-home-iztok-Projects-forgekit';

test('the join: a half-read host binding does not reach the one genuine host self', () => {
  // The gate this pins, end to end: `bucket === undefined` in
  // `hostFinalReview` — this module's own comment calls it "the one genuine
  // negative in this function" — must never fire off a `reviewEvidence`
  // answer that could only read half of a two-host-session binding. Read half
  // and reported `available: true` with `final` simply missing from `units`,
  // that half-read binding would look exactly like "the host looked and this
  // session's reviewer is not there", and a correct final review would refuse
  // at the money/auth gate.
  const FORGE_SESSION_ID = '20260730T161704Z-census-join-demo';
  const FIRST_HOST_ID = '99999999-8888-7777-6666-555555555555';
  const SECOND_HOST_ID = '11111111-2222-3333-4444-666666666666';

  // First host session, fully readable: a prescribed but non-`final` dispatch,
  // so `prescribed > 0` and the convention reads as in use here — the state in
  // which the final reviewer's absence from the table is supposed to mean
  // something.
  const configDir = plantHost({
    sessionId: FIRST_HOST_ID,
    lines: [PARENT_LINE],
    subagents: {
      a1: {
        meta: meta({ description: `forge-review group-01 ${FORGE_SESSION_ID}` }),
        lines: [assistantLine({ requestId: 'g_1', at: '2026-07-28T10:30:00.000Z' })],
      },
    },
  });

  // Second host session: the final reviewer ran here. Its session directory is
  // about to be made unsearchable, exactly as
  // `metrics/review-evidence.test.mjs` does it — `chmod 000` on the *session*
  // directory, not on `subagents/` itself: `statSync` succeeds on a `000`
  // directory because stat reads the parent's entry, so only the outer
  // directory reproduces an unreadable sidecar.
  plantHost({
    configDir,
    sessionId: SECOND_HOST_ID,
    lines: [PARENT_LINE],
    subagents: {
      a2: {
        meta: meta({ description: `forge-review final ${FORGE_SESSION_ID}` }),
        lines: [assistantLine({ requestId: 'f_1', at: '2026-07-28T11:00:00.000Z' })],
      },
    },
  });

  const secondHostDir = path.join(configDir, 'projects', HOST_PROJECT, SECOND_HOST_ID);
  const secondSidecarPath = path.join(secondHostDir, 'subagents');

  // The Forge session directory: a final review whose prose reads
  // `independent`. Load-bearing, deliberately: if the prose said `self`, the
  // verdict would be `self` either way and this test would pass against the
  // very defect it exists to catch. With the prose reading `independent` the
  // defect and the fix answer differently —
  //   defect: evidence available, `final` absent from `units` → `self` / `host`
  //   fixed:  evidence unavailable → prose decides → `independent` / `inferred`
  const dir = sessionWith({}, 'Reviewer: claude-opus-5 (final-reviewer)\n\n**READY**\n');

  const restore = installFsFaults([
    { method: 'statSync', path: secondSidecarPath, code: 'EACCES' },
  ]);
  try {
    // The fixture is only meaningful if the process genuinely cannot read it.
    assert.throws(() => fs.statSync(secondSidecarPath), /EACCES/);

    // Fixture guard, exactly as the existing tests in this file do: assert the
    // prose-alone reading before evidence enters the picture. A fixture whose
    // prose does not read as assumed would make the whole test vacuous.
    const bare = reviewCensus(dir);
    assert.equal(bare.finalReview, 'independent', 'fixture: prose alone says independent');

    // The real `reviewEvidence`, against the real on-disk fixture — not the
    // hand-written `evidence()` helper used everywhere else in this file.
    const evidence = reviewEvidence({
      session: {
        id: FORGE_SESSION_ID,
        createdAt: '2026-07-28T10:00:00.000Z',
        host: {
          agent: 'claude-code',
          sessionIds: [FIRST_HOST_ID, SECOND_HOST_ID],
          boundAt: '2026-07-28T10:00:00.000Z',
        },
      },
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      configDir,
    });
    // Pin the join's other half before trusting what the census does with it —
    // task 1.1's own coverage, re-asserted here so a regression there fails
    // this test for the right reason instead of a confusing census mismatch.
    assert.equal(evidence.available, false, 'fixture: reviewEvidence must be unavailable on the half-read binding');

    const census = reviewCensus(dir, { evidence });
    assert.equal(census.finalReview, 'independent', 'not self — a half-read binding must not decide the gate');
    assert.equal(census.finalReviewEvidence, 'inferred');
    // The evidence did not decide: the whole census matches the no-evidence
    // reading, field for field — the same "prose decided" statement the
    // neighbouring evidence tests in this file make.
    assert.deepEqual(census, bare, 'exactly what the prose rule alone returns');
  } finally {
    restore();
  }
});

test('the pruned-transcript limit reaches the census as independent on host grade (F12)', () => {
  // The companion to `metrics/review-evidence.test.mjs`'s "answers from the
  // surviving half when a bound session has no transcript at all" — same
  // deliberate limit, carried through to a verdict. The module-level test
  // alone does not connect the dots to `forge phase done`: this is the
  // assertion that fails loudly the day the gate starts refusing resumed
  // sessions, by asserting `independent` on `host` grade rather than merely
  // `available: true`.
  const FORGE_SESSION_ID = '20260730T161704Z-census-pruned-limit-demo';
  const READABLE_HOST_ID = '99999999-8888-7777-6666-444444444444';
  const ABSENT_HOST_ID = '00000000-1111-2222-3333-444444444444';

  const configDir = plantHost({
    sessionId: READABLE_HOST_ID,
    lines: [PARENT_LINE],
    subagents: {
      a1: {
        meta: meta({ description: `forge-review final ${FORGE_SESSION_ID}` }),
        // At least FINAL_REVIEW_REQUEST_FLOOR requests, or the census's own
        // floor — not this scenario — would be what refuses the unit.
        lines: Array.from({ length: FINAL_REVIEW_REQUEST_FLOOR }, (_, n) =>
          assistantLine({ requestId: `f_${n}`, at: '2026-07-28T11:00:00.000Z' }),
        ),
      },
    },
  });
  // ABSENT_HOST_ID is never planted at all — no `.jsonl` anywhere under
  // `projects/`, no `chmod`: the pruned, not blocked, case.

  const dir = sessionWith({}, 'Reviewer: coordinator — self-check\n\nAPPROVED\n');
  const bare = reviewCensus(dir);
  assert.equal(bare.finalReview, 'self', 'fixture: prose alone says self');

  const evidence = reviewEvidence({
    session: {
      id: FORGE_SESSION_ID,
      createdAt: '2026-07-28T10:00:00.000Z',
      host: {
        agent: 'claude-code',
        sessionIds: [ABSENT_HOST_ID, READABLE_HOST_ID],
        boundAt: '2026-07-28T10:00:00.000Z',
      },
    },
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    configDir,
  });
  // NOT a fixture precondition — this is the limit itself, restated. A pruned
  // half must not make the answer unavailable, so this line going red means the
  // product regressed toward refusing every resumed session, not that the
  // fixture broke. Worded this way because the `fixture:` prefix it used to
  // carry sent a reader hunting for a broken fixture instead.
  assert.equal(
    evidence.available,
    true,
    'the pruned half must not make the answer unavailable — this is the limit, not a fixture problem',
  );
  assert.equal(evidence.units.final?.dispatched, 1);

  const census = reviewCensus(dir, { evidence });
  assert.equal(census.finalReview, 'independent', 'the surviving half still certifies the review');
  assert.equal(census.finalReviewEvidence, 'host');
});
