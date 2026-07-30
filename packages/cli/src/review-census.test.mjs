import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CENSUS_RULE, FINAL_REVIEW_REQUEST_FLOOR, reviewCensus } from './review-census.mjs';

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
 * @param {{ units?: Record<string, {dispatched: number, stopped: number, requests: number,
 *     maxRequests: number}>,
 *   seen?: number, prescribed?: number, available?: boolean, reason?: string }} [spec]
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
