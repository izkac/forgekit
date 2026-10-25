/**
 * Review claim check — a blocking review item must carry evidence.
 *
 * A reviewer's REJECTED verdict used to count as a rejection however vague the
 * finding behind it. This reads the review markdown, finds the blocking items
 * (list items under a Critical / Important / Spec gap / Runtime-integrity
 * heading) and keeps only the ones a machine can recognise as backed:
 *
 *   1. `Command: <argv> → exit <int>`            (`->` accepted)
 *   2. `Spec: "<quote>"` + `Missing at: <path>[:<line>]`   (or `<file>: no <symbol>`)
 *   3. `Scenario: …` + `At: <path>:<line>` + `Expected: …` + `Actual: …`
 *
 * An unbacked blocking item is downgraded to Minor. The effective verdict is
 * REJECTED only when the review's own verdict is REJECTED and at least one
 * blocking item is backed. Pure: no I/O. Runtime callers: `forge review-check`
 * (`review-check-cli.mjs`) and the rejection count in `review-census.mjs`.
 */

/** A round that sent work back: proof the review was not a rubber stamp. */
export const REJECTION_RE = /(?:\bRound\s+\d+[^\n]*\bREJECTED\b|\*\*Verdict:\s*REJECTED\*\*)/i;

const BLOCKING_HEADING_RE = /critical|important|spec gap|runtime[- ]integrity/i;
const MINOR_HEADING_RE = /minor/i;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/** `**Label:**`, `**Label**:` and `Label:` — label case-insensitive, never glued to a preceding letter. */
const label = (name) => `(?<![A-Za-z])\\*{0,2}${name}\\*{0,2}:\\*{0,2}`;
/** Rest of the label's own line, non-empty (never reaches into the next line). */
const REST = '[ \\t]*(\\S[^\\n]*)';

const COMMAND_RE = new RegExp(`${label('Command')}[ \\t]*(\\S[^\\n]*?)[ \\t]*(?:→|->)[ \\t]*exit[ \\t]+-?\\d+`, 'i');
const SPEC_RE = new RegExp(`${label('Spec')}[ \\t]*["“]([^"”\\n]*\\S[^"”\\n]*)["”]`, 'i');
const MISSING_AT_RE = new RegExp(`${label('Missing at')}[ \\t]*\`?([^\\s\`]+)`, 'i');
const SCENARIO_RE = new RegExp(`${label('Scenario')}${REST}`, 'i');
const AT_RE = new RegExp(`(?<!Missing )${label('At')}[ \\t]*\`?([^\\s\`]+)`, 'i');
const EXPECTED_RE = new RegExp(`${label('Expected')}${REST}`, 'i');
const ACTUAL_RE = new RegExp(`${label('Actual')}${REST}`, 'i');

/**
 * A path-looking token: contains a separator or ends in an extension, with an
 * optional trailing `:<line>` / `:` (the `<file>: no <symbol>` form) removed.
 * @param {string | undefined} token
 * @param {{ needLine?: boolean }} [opts] `needLine` → a `:<line>` suffix is required
 */
function isPath(token, opts = {}) {
  if (!token) return false;
  const bare = token.replace(/[.,;)]+$/, '');
  const m = /^(.*?)(?::(\d+)(?:-\d+)?)?:?$/.exec(bare);
  const file = m?.[1] ?? '';
  if (opts.needLine && !m?.[2]) return false;
  return file.length > 0 && (/[\\/]/.test(file) || /\.\w+$/.test(file));
}

/**
 * Which evidence form (if any) backs this item body.
 * @param {string} body
 * @returns {'command' | 'spec' | 'scenario' | null}
 */
export function evidenceForm(body) {
  if (COMMAND_RE.test(body)) return 'command';
  if (SPEC_RE.test(body) && isPath(MISSING_AT_RE.exec(body)?.[1])) return 'spec';
  if (
    SCENARIO_RE.test(body) &&
    isPath(AT_RE.exec(body)?.[1], { needLine: true }) &&
    EXPECTED_RE.test(body) &&
    ACTUAL_RE.test(body)
  ) {
    return 'scenario';
  }
  return null;
}

export const UNPARSED_NOTE =
  'REJECTED but no blocking list items found — treated as REJECTED; findings must be list items under ## Critical/## Important';

/**
 * @param {string} markdown
 * @returns {{
 *   originalVerdict: 'REJECTED' | 'APPROVED',
 *   effectiveVerdict: 'REJECTED' | 'APPROVED',
 *   items: { heading: string, text: string, backed: boolean, form: 'command' | 'spec' | 'scenario' | null }[],
 *   unparsed: boolean, note: string | null,
 * }} `unparsed`: the review is REJECTED but no list item at all was found under a
 *   blocking or Minor heading, so there is nothing to downgrade — it stays REJECTED
 *   (a real defect written as prose, sub-headings or a bold label must not be skipped).
 */
export function checkReview(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const originalVerdict = REJECTION_RE.test(text) ? 'REJECTED' : 'APPROVED';

  /** @type {{ level: number, title: string }[]} */
  const stack = [];
  /** @type {{ heading: string, indent: number, lines: string[] }[]} */
  const found = [];
  /** @type {(typeof found)[number] | null} */
  let current = null;
  let inFence = false;

  let minorItems = 0;

  /** The innermost Minor-or-blocking heading decides; Minor wins, none → null. */
  const section = () => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (MINOR_HEADING_RE.test(stack[i].title)) return 'minor';
      if (BLOCKING_HEADING_RE.test(stack[i].title)) return 'blocking';
    }
    return null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      continue;
    }
    if (inFence) {
      if (current) current.lines.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2] });
      current = null;
      continue;
    }
    const li = LIST_ITEM_RE.exec(line);
    if (li && (!current || li[1].length <= current.indent)) {
      const kind = section();
      if (kind === 'minor') minorItems += 1;
      current = kind === 'blocking' ? { heading: stack[stack.length - 1].title, indent: li[1].length, lines: [li[2]] } : null;
      if (current) found.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  const items = found.map((f) => {
    const body = f.lines.join('\n').trimEnd();
    const form = evidenceForm(body);
    return { heading: f.heading, text: body, backed: form !== null, form };
  });
  const unparsed = originalVerdict === 'REJECTED' && items.length === 0 && minorItems === 0;
  const effectiveVerdict =
    originalVerdict === 'REJECTED' && (unparsed || items.some((i) => i.backed)) ? 'REJECTED' : 'APPROVED';
  const note = unparsed ? UNPARSED_NOTE : null;
  return { originalVerdict, effectiveVerdict, items, unparsed, note };
}
