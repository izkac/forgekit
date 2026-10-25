import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReview, REJECTION_RE } from './review-check.mjs';

const REJECTED = '**Verdict: REJECTED**';
const APPROVED = '**Verdict: APPROVED**';

/** A review with the given verdict line and sections of `[heading, ...itemBodies]`. */
function review(verdict, sections) {
  const out = [verdict, ''];
  for (const [heading, ...items] of sections) {
    out.push(heading, '');
    for (const item of items) out.push(item);
    out.push('');
  }
  return out.join('\n');
}

const NPM = 'npm test -- foo';
const CMD_ITEM = `- Foo breaks on empty input.\n  Command: ${NPM} → exit 1\n  output: 1 failing`;
const SPEC_ITEM = '- Retry cap is missing.\n  Spec: "retries at most 3 times"\n  Missing at: src/retry.mjs:12';
const SCENARIO_ITEM =
  '- Token check skipped.\n  Scenario: expired token\n  At: src/auth.mjs:42\n  Expected: 401\n  Actual: 200';
const BARE_ITEM = '- This feels wrong and should be reconsidered.';

test('unbacked Important claim in a REJECTED review is downgraded and the effective verdict is APPROVED', () => {
  const r = checkReview(review(REJECTED, [['## Important', BARE_ITEM]]));
  assert.equal(r.originalVerdict, 'REJECTED');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].backed, false);
  assert.equal(r.items[0].form, null);
  assert.equal(r.effectiveVerdict, 'APPROVED');
});

test('Important item with Command → exit is backed and the review stays REJECTED', () => {
  const r = checkReview(review(REJECTED, [['## Important', CMD_ITEM]]));
  assert.equal(r.items[0].backed, true);
  assert.equal(r.items[0].form, 'command');
  assert.equal(r.effectiveVerdict, 'REJECTED');
});

test('Critical item with Scenario / At / Expected / Actual is backed', () => {
  const r = checkReview(review(REJECTED, [['## Critical', SCENARIO_ITEM]]));
  assert.equal(r.items[0].backed, true);
  assert.equal(r.items[0].form, 'scenario');
  assert.equal(r.effectiveVerdict, 'REJECTED');
});

test('APPROVED review with Minor items only: nothing blocking, nothing downgraded, APPROVED', () => {
  const r = checkReview(review(APPROVED, [['## Minor', BARE_ITEM, '- another nit']]));
  assert.equal(r.originalVerdict, 'APPROVED');
  assert.deepEqual(r.items, []);
  assert.equal(r.effectiveVerdict, 'APPROVED');
});

test('a REJECTED review whose only items are Minor is effectively APPROVED', () => {
  const r = checkReview(review(REJECTED, [['## Minor', CMD_ITEM]]));
  assert.equal(r.originalVerdict, 'REJECTED');
  assert.deepEqual(r.items, []);
  assert.equal(r.effectiveVerdict, 'APPROVED');
});

test('Spec: quote plus Missing at: path is backed (form spec); the <file>: no <symbol> variant too', () => {
  const r = checkReview(review(REJECTED, [['## Spec gap', SPEC_ITEM]]));
  assert.equal(r.items[0].form, 'spec');
  const sym = checkReview(
    review(REJECTED, [['## Spec gap', '- x\n  Spec: "q"\n  Missing at: src/retry.mjs: no capRetries']]),
  );
  assert.equal(sym.items[0].form, 'spec');
  const bareFile = checkReview(review(REJECTED, [['## Spec gap', '- x\n  Spec: "q"\n  Missing at: README.md']]));
  assert.equal(bareFile.items[0].form, 'spec');
});

test('Runtime-integrity heading blocks too', () => {
  const r = checkReview(review(REJECTED, [['## Runtime integrity', CMD_ITEM]]));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].backed, true);
});

test('partial forms are unbacked: Spec without Missing at, Missing at without Spec, bad paths', () => {
  const cases = [
    '- x\n  Spec: "retries at most 3 times"',
    '- x\n  Missing at: src/retry.mjs:12',
    '- x\n  Spec: ""\n  Missing at: src/retry.mjs:12',
    '- x\n  Spec: "q"\n  Missing at: somewhere',
    '- x\n  Spec: "q"\n  Missing at: none',
  ];
  for (const item of cases) {
    const r = checkReview(review(REJECTED, [['## Important', item]]));
    assert.equal(r.items[0].backed, false, item);
  }
});

test('partial Scenario forms are unbacked: each missing label, At without a line number', () => {
  const full = ['Scenario: expired token', 'At: src/auth.mjs:42', 'Expected: 401', 'Actual: 200'];
  for (let drop = 0; drop < full.length; drop += 1) {
    const lines = full.filter((_, i) => i !== drop).map((l) => `  ${l}`);
    const r = checkReview(review(REJECTED, [['## Critical', `- x\n${lines.join('\n')}`]]));
    assert.equal(r.items[0].backed, false, `without ${full[drop]}`);
  }
  const noLine = full.map((l) => (l.startsWith('At:') ? 'At: src/auth.mjs' : l)).map((l) => `  ${l}`);
  assert.equal(checkReview(review(REJECTED, [['## Critical', `- x\n${noLine.join('\n')}`]])).items[0].backed, false);
});

test('Missing at: is not mistaken for the At: label of the Scenario form', () => {
  const item = '- x\n  Scenario: s\n  Missing at: src/a.mjs:3\n  Expected: e\n  Actual: a';
  assert.equal(checkReview(review(REJECTED, [['## Critical', item]])).items[0].backed, false);
});

test('Command needs a non-empty argv and an integer exit', () => {
  for (const item of [
    '- x\n  Command: → exit 1',
    '- x\n  Command: npm test → exit',
    '- x\n  Command: npm test → exit abc',
    '- x\n  Command: npm test',
  ]) {
    const r = checkReview(review(REJECTED, [['## Important', item]]));
    assert.equal(r.items[0].backed, false, item);
  }
});

test('Scenario with empty values on its own line does not borrow the next line', () => {
  const item = '- x\n  Scenario:\n  At: src/a.mjs:3\n  Expected: e\n  Actual: a';
  assert.equal(checkReview(review(REJECTED, [['## Critical', item]])).items[0].backed, false);
});

test('->, bold labels and case-insensitive labels are accepted', () => {
  const ascii = checkReview(review(REJECTED, [['## Important', `- x\n  Command: ${NPM} -> exit 2`]]));
  assert.equal(ascii.items[0].form, 'command');
  const bold = checkReview(review(REJECTED, [['## Important', `- x\n  **Command:** ${NPM} → exit 1`]]));
  assert.equal(bold.items[0].form, 'command');
  const boldColonOutside = checkReview(review(REJECTED, [['## Important', `- x\n  **Command**: ${NPM} → exit 1`]]));
  assert.equal(boldColonOutside.items[0].form, 'command');
  const lower = checkReview(review(REJECTED, [['## Important', `- x\n  command: ${NPM} → exit 1`]]));
  assert.equal(lower.items[0].form, 'command');
  const boldScenario = checkReview(
    review(REJECTED, [
      ['## Critical', '- x\n  **Scenario:** s\n  **At:** `src/auth.mjs:42`\n  **Expected:** e\n  **Actual:** a'],
    ]),
  );
  assert.equal(boldScenario.items[0].form, 'scenario');
});

test('item body spans continuation lines and nested list items, and stops at the next same-indent item', () => {
  const md = review(REJECTED, [
    [
      '## Important',
      '- first item, no evidence',
      '  - nested detail',
      '  more prose',
      `- second item\n  Command: ${NPM} → exit 1`,
    ],
  ]);
  const r = checkReview(md);
  assert.equal(r.items.length, 2);
  assert.match(r.items[0].text, /nested detail/);
  assert.match(r.items[0].text, /more prose/);
  assert.equal(r.items[0].backed, false);
  assert.equal(r.items[1].backed, true);
  assert.doesNotMatch(r.items[0].text, /Command/);
});

test('evidence belonging to the next item does not back the previous one', () => {
  const md = review(REJECTED, [['## Important', '- unbacked', `- backed\n  Command: ${NPM} → exit 1`]]);
  const r = checkReview(md);
  assert.deepEqual(
    r.items.map((i) => i.backed),
    [false, true],
  );
});

test('numbered and star list items are items', () => {
  const md = review(REJECTED, [['## Important', `1. numbered\n   Command: ${NPM} → exit 1`, '* starred']]);
  const r = checkReview(md);
  assert.deepEqual(
    r.items.map((i) => i.backed),
    [true, false],
  );
});

test('items end at the next heading of the same or higher level; Minor heading is never blocking', () => {
  const md = review(REJECTED, [
    ['## Important', BARE_ITEM],
    ['## Minor', CMD_ITEM],
    ['## Notes', CMD_ITEM],
  ]);
  const r = checkReview(md);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].backed, false);
});

test('a lower-level heading under Important keeps its items blocking, a Minor sub-heading does not', () => {
  const md = [
    REJECTED,
    '## Important',
    '### Details',
    '- under details',
    '### Minor notes',
    `- nit\n  Command: ${NPM} → exit 1`,
  ].join('\n');
  const r = checkReview(md);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, 'under details');
  assert.equal(r.effectiveVerdict, 'APPROVED');
});

test('list items and headings inside code fences are not parsed', () => {
  const md = [
    REJECTED,
    '## Important',
    '- the real item',
    '  ```',
    '  ## Minor',
    '  - fenced bullet',
    `  Command: ${NPM} → exit 1`,
    '  ```',
  ].join('\n');
  const r = checkReview(md);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].backed, true);
});

test('Round-style REJECTED heading is detected like REJECTION_RE; effective verdict needs a backed item', () => {
  const md = `Round 2 — REJECTED\n\n## Important\n\n${CMD_ITEM}\n`;
  assert.ok(REJECTION_RE.test(md));
  const r = checkReview(md);
  assert.equal(r.originalVerdict, 'REJECTED');
  assert.equal(r.effectiveVerdict, 'REJECTED');
});

test('mixed review: one backed item keeps REJECTED while the unbacked one is reported downgraded', () => {
  const r = checkReview(review(REJECTED, [['## Critical', BARE_ITEM, CMD_ITEM], ['## Important', SPEC_ITEM]]));
  assert.deepEqual(
    r.items.map((i) => [i.heading, i.form]),
    [
      ['Critical', null],
      ['Critical', 'command'],
      ['Important', 'spec'],
    ],
  );
  assert.equal(r.effectiveVerdict, 'REJECTED');
});

test('non-string input is an empty APPROVED review', () => {
  const r = checkReview(undefined);
  assert.deepEqual(r, { originalVerdict: 'APPROVED', effectiveVerdict: 'APPROVED', items: [], unparsed: false, note: null });
});

test('REJECTED with findings that are not list items under a blocking heading stays REJECTED and is flagged unparsed', () => {
  const shapes = {
    'sub-headings': `${REJECTED}\n\n## Critical\n\n### 1. Foo breaks\n\nIt crashes on empty input.\n`,
    'paragraph under heading': `${REJECTED}\n\n## Critical\n\nFoo crashes on empty input and nothing handles it.\n`,
    'bold label, not a heading': `${REJECTED}\n\n**Critical**\n\n- Foo crashes on empty input.\n`,
  };
  for (const [name, md] of Object.entries(shapes)) {
    const r = checkReview(md);
    assert.deepEqual(r.items, [], name);
    assert.equal(r.originalVerdict, 'REJECTED', name);
    assert.equal(r.effectiveVerdict, 'REJECTED', name);
    assert.equal(r.unparsed, true, name);
    assert.match(r.note, /no blocking list items/i, name);
  }
});

test('a bare Round REJECTED line with no findings at all is unparsed REJECTED', () => {
  const r = checkReview('## Round 1 — REJECTED\n');
  assert.equal(r.effectiveVerdict, 'REJECTED');
  assert.equal(r.unparsed, true);
});

test('unparsed is false whenever a blocking item was parsed, backed or not, and for APPROVED reviews', () => {
  assert.equal(checkReview(review(REJECTED, [['## Important', BARE_ITEM]])).unparsed, false);
  assert.equal(checkReview(review(REJECTED, [['## Important', CMD_ITEM]])).unparsed, false);
  assert.equal(checkReview(review(APPROVED, [['## Important', BARE_ITEM]])).unparsed, false);
  assert.equal(checkReview(`${APPROVED}\n\n## Critical\n\nprose only\n`).unparsed, false);
  assert.equal(checkReview(review(REJECTED, [['## Important', BARE_ITEM]])).note, null);
});

test('Minor-only REJECTED stays downgraded: its findings were parsed and classed non-blocking', () => {
  const r = checkReview(review(REJECTED, [['## Minor', BARE_ITEM]]));
  assert.equal(r.unparsed, false);
  assert.equal(r.effectiveVerdict, 'APPROVED');
});
