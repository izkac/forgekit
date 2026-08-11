/**
 * Guards against `skills/forge/references/pace.md`'s preset effort matrix
 * drifting away from `preferences.defaults.json` — the file that actually
 * runs. The matrix is prose an agent reads every session; the JSON is the
 * behaviour. Nothing stops them disagreeing except this test.
 *
 * Parsing is defensive on purpose (see `parsePaceMatrix`): a regex that
 * matches nothing, or matches the wrong rows, must be distinguishable from a
 * real value mismatch — otherwise a broken parser "passes" by accident,
 * which is worse than no test. The row/column count assertions below exist
 * for exactly that: they fail loudly, with a different message, before any
 * value comparison runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS_PATH } from './preferences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACE_MD_PATH = path.resolve(__dirname, '../../../skills/forge/references/pace.md');

// Mirrors plan-facts.mjs's FENCE_RE/stripFencedBlocks (not exported there, so
// duplicated here rather than reaching into an unexported internal). Keeps a
// fenced example table from hijacking the header match below.
const FENCE_RE = /^```[\s\S]*?^```/gm;

/**
 * Remove fenced code blocks so example tables inside them are not mistaken
 * for the real matrix.
 *
 * @param {string} body
 * @returns {string}
 */
function stripFencedBlocks(body) {
  return body.replace(FENCE_RE, '');
}

/** Knob rows, in the order they must appear in the matrix — a dot-path into each preset's JSON object. */
const EXPECTED_KNOBS = Object.freeze([
  'review.perTask',
  'review.final',
  'review.depth',
  'review.maxRounds',
  'verify.tier3',
  'models.bias',
  'brainstorm.depth',
]);

const EXPECTED_PRESETS = Object.freeze(['thorough', 'standard', 'brisk', 'lite']);

/**
 * Split one markdown table row (`| a | b | c |`) into trimmed cells, without
 * the leading/trailing empty entries `split('|')` produces from the edge
 * pipes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Strip markdown emphasis/code markup from a cell (`**review.perTask**` →
 * `review.perTask`, `` `thorough` `` → `thorough`).
 *
 * @param {string} cell
 * @returns {string}
 */
function stripMarkup(cell) {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/**
 * Reduce a matrix cell to the bare enum/number value the JSON stores.
 *
 * Handles the two decorations the matrix actually uses:
 * - a footnote marker (`never\*`) — the literal two characters `\` `*`
 *   trailing the value, not markdown emphasis;
 * - a parenthetical annotation (`short (≤2–3 options)`) — extra prose after
 *   the value, kept in the doc for a human reader but not part of the value.
 *
 * A reflowed table row (extra spaces, wrapped backticks) does not change any
 * of this, which is the point: only the value and its two known decorations
 * are special-cased, nothing about column width or spacing.
 *
 * @param {string} cell
 * @returns {string}
 */
function parseCellValue(cell) {
  let value = cell.replace(/`/g, '').trim();
  value = value.replace(/\\\*/g, '').trim(); // footnote marker
  const parenIndex = value.indexOf('(');
  if (parenIndex !== -1) value = value.slice(0, parenIndex).trim();
  return value;
}

/**
 * Parse the "Presets (effort matrix)" table out of `pace.md`.
 *
 * Strips fenced code blocks first so an example table inside a fence cannot
 * be mistaken for the real matrix, then locates the table by its header row
 * (`| Knob | ... |`) rather than a line number or a section heading, so
 * reordering surrounding prose does not break it — only the table's own
 * header row and immediate separator row matter.
 *
 * @param {string} text
 * @returns {{ presets: string[], matrix: Record<string, string[]> }}
 */
function parsePaceMatrix(rawText) {
  const text = stripFencedBlocks(rawText);
  const lines = text.split('\n');
  const headerIndex = lines.findIndex((line) => /^\|\s*Knob\s*\|/i.test(line.trim()));
  assert.notEqual(
    headerIndex,
    -1,
    'pace.md: could not find the matrix header row ("| Knob | ... |") — the table may have been renamed or removed',
  );

  const separator = lines[headerIndex + 1] ?? '';
  assert.match(
    separator.trim(),
    /^\|[-\s|]+\|$/,
    'pace.md: matrix header is not immediately followed by a table separator row (|---|---|...)',
  );

  const header = splitTableRow(lines[headerIndex]).slice(1).map(stripMarkup);

  /** @type {Record<string, string[]>} */
  const matrix = {};
  let i = headerIndex + 2;
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    const cells = splitTableRow(lines[i]);
    const knob = stripMarkup(cells[0]);
    matrix[knob] = cells.slice(1).map(parseCellValue);
    i += 1;
  }

  return { presets: header, matrix };
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} dotPath
 * @returns {unknown}
 */
function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

test('pace.md matrix: parser actually finds the table (row/column counts, not values)', () => {
  const text = fs.readFileSync(PACE_MD_PATH, 'utf8');
  const { presets, matrix } = parsePaceMatrix(text);

  // Fail here, distinctly from a value mismatch below, if the regex matched
  // nothing useful or the wrong rows — e.g. a reflow that shifted the table
  // and left the parser reading zero or the wrong number of rows, which
  // would otherwise let every value comparison "pass" by comparing nothing.
  assert.deepEqual(
    presets,
    EXPECTED_PRESETS,
    `expected preset columns ${JSON.stringify(EXPECTED_PRESETS)}, parsed ${JSON.stringify(presets)}`,
  );
  assert.deepEqual(
    Object.keys(matrix),
    EXPECTED_KNOBS,
    `expected knob rows ${JSON.stringify(EXPECTED_KNOBS)}, parsed ${JSON.stringify(Object.keys(matrix))}`,
  );
});

test('parsePaceMatrix ignores a decoy table inside a fenced code block', () => {
  // A fenced example table earlier in the doc must not hijack the header
  // match — only the real, unfenced matrix should be parsed.
  const fixture = [
    'Some intro prose.',
    '',
    '```markdown',
    '| Knob | thorough | standard | brisk | lite |',
    '|------|------------|------------|---------|--------|',
    '| **review.perTask** | DECOY | DECOY | DECOY | DECOY |',
    '```',
    '',
    'Real table below.',
    '',
    '| Knob | thorough | standard | brisk | lite |',
    '|------|------------|------------|---------|--------|',
    '| **review.perTask** | per-group | per-group | never\\* | never\\* |',
    '| **review.final** | always | always | always | always |',
    '| **review.depth** | full | full | spec-only | spec-only |',
    '| **review.maxRounds** | 3 | 2 | 1 | 1 |',
    '| **verify.tier3** | full-workspace | full-workspace | affected-only | audit-tier2-only |',
    '| **models.bias** | default | default | prefer-fast | prefer-fast |',
    '| **brainstorm.depth** | full | full | short (≤2–3 options) | minimal |',
    '',
  ].join('\n');

  const { presets, matrix } = parsePaceMatrix(fixture);

  assert.deepEqual(presets, EXPECTED_PRESETS);
  assert.equal(
    matrix['review.perTask'][0],
    'per-group',
    'expected the real table row, not the fenced decoy — the header match picked the wrong table',
  );
});

test('pace.md matrix matches preferences.defaults.json, cell for cell', () => {
  const text = fs.readFileSync(PACE_MD_PATH, 'utf8');
  const { presets, matrix } = parsePaceMatrix(text);
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));

  for (const knob of EXPECTED_KNOBS) {
    presets.forEach((preset, columnIndex) => {
      const documented = matrix[knob][columnIndex];
      const shipped = getPath(defaults.presets[preset], knob);
      assert.notEqual(
        shipped,
        undefined,
        `preferences.defaults.json has no presets.${preset}.${knob} — pace.md documents a knob that does not exist`,
      );
      assert.equal(
        documented,
        String(shipped),
        `pace.md presets.${preset}.${knob} documents "${documented}" but preferences.defaults.json ships "${shipped}"`,
      );
    });
  }
});
