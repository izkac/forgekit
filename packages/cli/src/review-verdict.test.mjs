import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { frozenReviewVerdict } from './review-verdict.mjs';

// The legal values live in `review-verdict.mjs` and are not exported, so they
// are read out of the module's own source rather than restated here. A value
// added to either set therefore flows into the round-trip below and is
// *exercised*, instead of being silently skipped by a copy that stopped
// agreeing with the module.
const SOURCE = fs.readFileSync(new URL('./review-verdict.mjs', import.meta.url), 'utf8');

/** The string literals of a `const <name> = new Set([...])` in the module. */
function setLiteral(name) {
  const block = SOURCE.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(block, `could not find ${name} in review-verdict.mjs — this test file is stale`);
  const values = [...block[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  assert.ok(values.length > 0, `${name} parsed as empty — the extraction is broken, not the module`);
  return values;
}

const FINAL = setLiteral('FINAL');
const EVIDENCE = setLiteral('EVIDENCE');

/** Every `final` the module accepts, including the legal `null`. */
const LEGAL_FINALS = [...FINAL, null];

/** A verdict of the exact shape `set-phase.mjs` writes. */
function verdict(fields = {}) {
  return { final: null, evidence: 'none', stoppedByOperator: false, ...fields };
}

test('the legal values are the ones this file was written against', () => {
  // A tripwire, not a second copy: every other test derives its inputs from the
  // module, so an added value would be absorbed silently and this is the one
  // place that notices. Widening either set is a real decision — it widens what
  // the money/auth done gate will accept as a measured verdict — so it should
  // cost one deliberate edit here rather than nothing at all.
  assert.deepEqual(FINAL, ['independent', 'self']);
  assert.deepEqual(EVIDENCE, ['host', 'recorded', 'inferred', 'none']);
});

test('a session that is not an object at all has no verdict to read', () => {
  // `null` and `undefined` are the ones with teeth: without the guard the
  // property read throws, and the caller is `forge phase done`, where a throw
  // loses the transition rather than falling back to a census.
  //
  // The function is the discriminating case for the `typeof` half — it is
  // truthy, so the falsy half lets it through, and it answers `reviewVerdict`
  // with a verdict that would otherwise be accepted. A session is a parsed
  // `session.json`; nothing else may stand in for one.
  const callable = () => {};
  callable.reviewVerdict = verdict({ final: 'independent', evidence: 'host' });

  for (const notASession of [
    null,
    undefined,
    '',
    'session.json',
    0,
    42,
    Number.NaN,
    true,
    false,
    Symbol('session'),
    callable,
  ]) {
    assert.equal(
      frozenReviewVerdict(notASession),
      null,
      `accepted ${String(typeof notASession)} ${String(notASession)}`,
    );
  }
});

test('a session with no reviewVerdict is absent, not a verdict', () => {
  // Every session that finished before the verdict existed looks like this.
  // `null` here means "fall back to a live census", never "refuse the work".
  assert.equal(frozenReviewVerdict({}), null);
  assert.equal(frozenReviewVerdict({ id: 's1', phase: 'done' }), null);
  assert.equal(frozenReviewVerdict({ reviewVerdict: undefined }), null);
  assert.equal(frozenReviewVerdict({ reviewVerdict: null }), null);
  assert.equal(frozenReviewVerdict(Object.create(null)), null);
});

test('an array-shaped verdict is refused even when it carries the right fields', () => {
  // Discriminating on purpose: `typeof [] === 'object'` and the destructuring
  // below would succeed, so a bare `[]` proves nothing about the `Array.isArray`
  // guard. This array answers every field correctly and must still be refused —
  // it did not come from `set-phase.mjs`, and a shape nobody wrote is not a
  // measurement.
  const asArray = [];
  asArray.final = 'independent';
  asArray.evidence = 'host';
  asArray.stoppedByOperator = false;
  assert.equal(frozenReviewVerdict({ reviewVerdict: asArray }), null);

  assert.equal(frozenReviewVerdict({ reviewVerdict: [] }), null);
  assert.equal(frozenReviewVerdict({ reviewVerdict: [verdict()] }), null);
});

test('a reviewVerdict that is not an object is refused', () => {
  for (const notAVerdict of ['', 'independent', 'host', 0, 1, 42, true, false, Symbol('v')]) {
    assert.equal(
      frozenReviewVerdict({ reviewVerdict: notAVerdict }),
      null,
      `accepted ${String(notAVerdict)}`,
    );
  }

  // A function is `typeof 'function'`, not `'object'`, and can carry the fields
  // — the discriminating case for the `typeof` half of the guard.
  const asFunction = () => {};
  Object.assign(asFunction, verdict({ final: 'self', evidence: 'inferred' }));
  assert.equal(frozenReviewVerdict({ reviewVerdict: asFunction }), null);
});

test('final: null is a verdict — "there is no final review" — not a missing value', () => {
  // The case most likely to be got wrong, and the reason the module tests
  // membership before nullness. `null` here must produce a *verdict object*
  // whose `final` is null; returning `null` from the function instead would say
  // "unrecognised shape, go and measure again", which is a different claim and
  // the one that re-reads evidence that no longer exists.
  for (const evidence of EVIDENCE) {
    for (const stoppedByOperator of [true, false]) {
      const session = { reviewVerdict: verdict({ final: null, evidence, stoppedByOperator }) };
      const got = frozenReviewVerdict(session);

      assert.notEqual(got, null, `final: null with evidence ${evidence} was read as no verdict`);
      assert.deepEqual(got, { final: null, evidence, stoppedByOperator });
      assert.equal(got.final, null, 'and the verdict it returns still says "no final review"');
    }
  }
});

test('an unrecognised final falls back to a live census', () => {
  // Only `final` is wrong in each fixture — evidence and stoppedByOperator stay
  // legal — so a failure here can only be the membership test.
  for (const final of [
    'Independent',
    'INDEPENDENT',
    'independant',
    'self ',
    '',
    'none',
    'host',
    0,
    1,
    true,
    false,
    undefined,
    {},
    ['self'],
    ['independent'],
  ]) {
    assert.equal(
      frozenReviewVerdict({ reviewVerdict: verdict({ final, evidence: 'host' }) }),
      null,
      `accepted final ${JSON.stringify(final) ?? String(final)}`,
    );
  }

  // A verdict object with no `final` key at all is the half-written case, and
  // is not the same as `final: null`.
  const noFinal = { evidence: 'host', stoppedByOperator: false };
  assert.equal(frozenReviewVerdict({ reviewVerdict: noFinal }), null);
});

test('an unrecognised evidence falls back to a live census', () => {
  // Note the asymmetry with `final`: `null` is a legal `final` and an illegal
  // `evidence`. "There is no final review" is spelt `evidence: 'none'`, which is
  // a grade the census can reach; `null` is not.
  for (const evidence of [
    'Host',
    'HOST',
    'hosted',
    'live',
    '',
    ' none',
    'independent',
    null,
    0,
    1,
    true,
    false,
    undefined,
    {},
    ['host'],
  ]) {
    assert.equal(
      frozenReviewVerdict({ reviewVerdict: verdict({ final: 'self', evidence }) }),
      null,
      `accepted evidence ${JSON.stringify(evidence) ?? String(evidence)}`,
    );
  }

  const noEvidence = { final: 'self', stoppedByOperator: false };
  assert.equal(frozenReviewVerdict({ reviewVerdict: noEvidence }), null);
});

test('stoppedByOperator must be an actual boolean, and false is one', () => {
  for (const stoppedByOperator of [
    0,
    1,
    'true',
    'false',
    '',
    null,
    undefined,
    {},
    [],
    new Boolean(true),
  ]) {
    assert.equal(
      frozenReviewVerdict({
        reviewVerdict: verdict({ final: 'independent', evidence: 'host', stoppedByOperator }),
      }),
      null,
      `accepted stoppedByOperator ${JSON.stringify(stoppedByOperator) ?? String(stoppedByOperator)}`,
    );
  }

  const noFlag = { final: 'independent', evidence: 'host' };
  assert.equal(frozenReviewVerdict({ reviewVerdict: noFlag }), null);

  // The other direction: `false` is a legal answer, and a truthiness test here
  // would throw away every verdict from a session the operator did not stop —
  // which is nearly all of them.
  assert.deepEqual(
    frozenReviewVerdict({
      reviewVerdict: verdict({ final: 'independent', evidence: 'host', stoppedByOperator: false }),
    }),
    { final: 'independent', evidence: 'host', stoppedByOperator: false },
  );
});

test('every legal combination round-trips to exactly the three fields', () => {
  let combinations = 0;

  for (const final of LEGAL_FINALS) {
    for (const evidence of EVIDENCE) {
      for (const stoppedByOperator of [true, false]) {
        const frozen = { final, evidence, stoppedByOperator };
        const got = frozenReviewVerdict({ id: 's1', phase: 'done', reviewVerdict: { ...frozen } });

        assert.deepEqual(got, frozen, `round trip lost ${JSON.stringify(frozen)}`);
        assert.deepEqual(
          Object.keys(got).sort(),
          ['evidence', 'final', 'stoppedByOperator'],
          `extra or missing keys for ${JSON.stringify(frozen)}`,
        );
        combinations += 1;
      }
    }
  }

  // Derived from the module's own sets, so a value added to either raises this
  // count and is genuinely exercised above rather than counted twice.
  assert.equal(combinations, LEGAL_FINALS.length * EVIDENCE.length * 2);
  assert.ok(combinations >= 12, `only ${combinations} legal combinations were exercised`);
});

test('extra keys on the verdict are dropped, not passed through', () => {
  // The three consumers read the returned object, not the stored one. Passing
  // the stored object straight through would let a hand-edited `session.json`
  // smuggle fields past a validator whose whole job is that they cannot.
  const stored = {
    final: 'independent',
    evidence: 'host',
    stoppedByOperator: true,
    measuredAt: '2026-07-30T08:00:00.000Z',
    note: 'hand edited',
    stoppedByOperatorReason: 'nope',
  };
  const got = frozenReviewVerdict({ reviewVerdict: stored });

  assert.deepEqual(got, { final: 'independent', evidence: 'host', stoppedByOperator: true });
  assert.notEqual(got, stored, 'the stored object must not be handed back by reference');
  assert.equal(Object.hasOwn(got, 'note'), false);
  assert.equal(Object.hasOwn(got, 'measuredAt'), false);
});

test('a frozen session is read without throwing', () => {
  // `forge phase done` is the only caller path. A throw there loses the
  // transition; falling back to a census does not.
  const session = Object.freeze({
    id: 's1',
    reviewVerdict: Object.freeze({ final: 'self', evidence: 'inferred', stoppedByOperator: true }),
  });

  let got;
  assert.doesNotThrow(() => {
    got = frozenReviewVerdict(session);
  });
  assert.deepEqual(got, { final: 'self', evidence: 'inferred', stoppedByOperator: true });
});

test('a prototype-less session is read without throwing', () => {
  const stored = Object.create(null);
  stored.final = 'independent';
  stored.evidence = 'host';
  stored.stoppedByOperator = false;
  const session = Object.create(null);
  session.reviewVerdict = stored;

  let got;
  assert.doesNotThrow(() => {
    got = frozenReviewVerdict(session);
  });
  assert.deepEqual(got, { final: 'independent', evidence: 'host', stoppedByOperator: false });

  // And a prototype-less object that is *not* a verdict is still refused.
  const empty = Object.create(null);
  empty.reviewVerdict = Object.create(null);
  assert.equal(frozenReviewVerdict(empty), null);
});

test('a hostile session object never costs the caller its transition', () => {
  // The module's contract line is "never throws", and shape alone does not buy
  // it: a property read can raise. Without a `try` around the body, a throwing
  // getter or Proxy trap propagates out of the validator and out of the
  // `forge phase done` transition that called it — the transition is lost, and
  // "unreadable" is not grounds to refuse work that a live census could still
  // grade.
  //
  // Reachability today is low: all three consumers pass an object from
  // `JSON.parse`, which cannot produce getters or Proxies. The contract is
  // still what the next consumer will read and rely on, so it is held here.
  const boom = () => {
    throw new Error('boom');
  };

  const hostile = {
    'a getter on reviewVerdict': {
      get reviewVerdict() {
        return boom();
      },
    },
    'a getter on final': {
      reviewVerdict: {
        get final() {
          return boom();
        },
        evidence: 'host',
        stoppedByOperator: false,
      },
    },
    'a getter on evidence': {
      reviewVerdict: {
        final: 'self',
        get evidence() {
          return boom();
        },
        stoppedByOperator: false,
      },
    },
    'a getter on stoppedByOperator': {
      reviewVerdict: {
        final: 'self',
        evidence: 'host',
        get stoppedByOperator() {
          return boom();
        },
      },
    },
    'a Proxy session whose traps throw': new Proxy({}, { get: boom, has: boom }),
    'a Proxy verdict whose traps throw': { reviewVerdict: new Proxy({}, { get: boom, has: boom }) },
  };

  for (const [label, session] of Object.entries(hostile)) {
    let got;
    assert.doesNotThrow(() => {
      got = frozenReviewVerdict(session);
    }, `${label} escaped the validator`);
    // And "did not throw" is not enough on its own: an unreadable session is an
    // unrecognised shape, so the answer is "fall back to a live census".
    assert.equal(got, null, label);
  }
});
