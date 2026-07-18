#!/usr/bin/env node
/**
 * Merge tentative scout findings from a directory of per-scout JSON files
 * into a single deduplicated `merged.json`.
 *
 * Every `*.json` file in the directory (except `merged.json`) is read; each
 * must have shape `{ findings: [...] }` where a finding carries the scout
 * tentative fields (`id`, `lens`, `location`, `claim`, `evidence`, optional
 * `context`/`related`, `tentative_severity`, `confidence`).
 *
 * Two findings are duplicates when they point at the same location FILE
 * (line suffix stripped), their first line numbers are within ±5 (a finding
 * without a line number only dupes another no-line finding in the same
 * file), and they share the same `lens`. The survivor is the one with the
 * higher `tentative_severity` (critical > important > minor), tie-broken by
 * higher `confidence` (high > medium > low), tie-broken by first
 * encountered; the discarded finding's original id is appended to the
 * survivor's `related` array.
 *
 * Survivors are renumbered `F-001`, `F-002`, ... in stable order sorted by
 * (location file, first line number ascending, original id) and written to
 * `<dir>/merged.json` as `{ findings: [...] }`.
 *
 * A malformed input file (invalid JSON, or no `findings` array) exits 1
 * naming the offending file, and merged.json is NOT written.
 *
 * Usage:
 *   review merge --dir <path>
 *
 * Options:
 *   --dir <path>  Directory of scout tentative JSON files (required),
 *                 e.g. .reviews/<id>-tentative/
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LINE_WINDOW = 5;

/** @type {Record<string, number>} */
const SEVERITY_RANK = { critical: 3, important: 2, minor: 1 };

/** @type {Record<string, number>} */
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    dir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

/**
 * Extract the file path from a finding location by stripping a trailing
 * `:line` or `:start-end` suffix.
 *
 * @param {string} location
 * @returns {string}
 */
export function locationFile(location) {
  return String(location).replace(/:\d+(-\d+)?$/, '');
}

/**
 * First line number of a finding location (`a.ts:42` → 42, `a.ts:10-20` →
 * 10), or null when the location has no line suffix.
 *
 * @param {string} location
 * @returns {number | null}
 */
export function firstLineNumber(location) {
  const m = /:(\d+)(-\d+)?$/.exec(String(location));
  return m ? Number(m[1]) : null;
}

/**
 * Whether two findings are duplicates: same location file, same lens, and
 * first line numbers within ±LINE_WINDOW. A finding without a line number
 * only dupes another no-line finding in the same file.
 *
 * @param {{ location?: unknown, lens?: unknown }} a
 * @param {{ location?: unknown, lens?: unknown }} b
 * @returns {boolean}
 */
export function isDuplicate(a, b) {
  if (a.lens !== b.lens) return false;
  const fileA = locationFile(/** @type {string} */ (a.location ?? ''));
  const fileB = locationFile(/** @type {string} */ (b.location ?? ''));
  if (fileA !== fileB) return false;
  const lineA = firstLineNumber(/** @type {string} */ (a.location ?? ''));
  const lineB = firstLineNumber(/** @type {string} */ (b.location ?? ''));
  if (lineA === null || lineB === null) return lineA === lineB;
  return Math.abs(lineA - lineB) <= LINE_WINDOW;
}

/**
 * @param {{ tentative_severity?: unknown, confidence?: unknown }} finding
 * @returns {[number, number]} [severityRank, confidenceRank]
 */
function rank(finding) {
  return [
    SEVERITY_RANK[/** @type {string} */ (finding.tentative_severity)] ?? 0,
    CONFIDENCE_RANK[/** @type {string} */ (finding.confidence)] ?? 0,
  ];
}

/**
 * Union of related-id arrays plus the discarded finding's own id, preserving
 * first-seen order without duplicates.
 *
 * @param {Record<string, unknown>} winner
 * @param {Record<string, unknown>} loser
 * @returns {string[]}
 */
function mergedRelated(winner, loser) {
  const out = [];
  const seen = new Set();
  const winnerRelated = Array.isArray(winner.related) ? winner.related : [];
  const loserRelated = Array.isArray(loser.related) ? loser.related : [];
  for (const id of [...winnerRelated, ...loserRelated, loser.id]) {
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(/** @type {string} */ (id));
  }
  return out;
}

/**
 * Collapse duplicate findings (in encounter order). Each newcomer is
 * compared against the current survivors; on a duplicate the higher-ranked
 * finding survives and absorbs the loser's original id (and any prior
 * `related` entries) into its `related` array.
 *
 * @param {Array<Record<string, unknown>>} findings In encounter order.
 * @returns {{ survivors: Array<Record<string, unknown>>, collapsed: number }}
 */
export function dedupeFindings(findings) {
  /** @type {Array<Record<string, unknown>>} */
  const survivors = [];
  let collapsed = 0;

  for (const finding of findings) {
    const candidate = { ...finding };
    const index = survivors.findIndex((s) => isDuplicate(s, candidate));
    if (index === -1) {
      survivors.push(candidate);
      continue;
    }

    collapsed += 1;
    const incumbent = survivors[index];
    const [sevA, confA] = rank(incumbent);
    const [sevB, confB] = rank(candidate);
    const candidateWins = sevB > sevA || (sevB === sevA && confB > confA);
    const winner = candidateWins ? candidate : incumbent;
    const loser = candidateWins ? incumbent : candidate;
    winner.related = mergedRelated(winner, loser);
    survivors[index] = winner;
  }

  return { survivors, collapsed };
}

/**
 * Renumber findings `F-001`, `F-002`, ... in stable order sorted by
 * (location file, first line number ascending — no-line first, original id).
 *
 * @param {Array<Record<string, unknown>>} findings
 * @returns {Array<Record<string, unknown>>}
 */
export function renumberFindings(findings) {
  const sorted = [...findings].sort((a, b) => {
    const locA = /** @type {string} */ (a.location ?? '');
    const locB = /** @type {string} */ (b.location ?? '');
    const fileCmp = locationFile(locA).localeCompare(locationFile(locB));
    if (fileCmp !== 0) return fileCmp;
    const lineA = firstLineNumber(locA) ?? -1;
    const lineB = firstLineNumber(locB) ?? -1;
    if (lineA !== lineB) return lineA - lineB;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  return sorted.map((finding, i) => ({
    ...finding,
    id: `F-${String(i + 1).padStart(3, '0')}`,
  }));
}

/**
 * @param {{ dir?: string | null }} opts
 * @param {string} [cwd]
 * @returns {{ exitCode: number; message: string }}
 */
export function runMerge(opts, cwd = process.cwd()) {
  if (!opts.dir) {
    return { exitCode: 1, message: '--dir <path> is required' };
  }

  const dir = path.isAbsolute(opts.dir) ? opts.dir : path.resolve(cwd, opts.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { exitCode: 1, message: `not a directory: ${dir}` };
  }

  const inputNames = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'merged.json')
    .sort();
  if (inputNames.length === 0) {
    return { exitCode: 1, message: `no input *.json files in ${dir}` };
  }

  /** @type {Array<Record<string, unknown>>} */
  const allFindings = [];
  const lines = [];
  for (const name of inputNames) {
    const full = path.join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      return {
        exitCode: 1,
        message: `invalid JSON in ${full}: ${/** @type {Error} */ (err).message}`,
      };
    }
    if (!parsed || !Array.isArray(parsed.findings)) {
      return { exitCode: 1, message: `no findings array in ${full}` };
    }
    allFindings.push(...parsed.findings);
    lines.push(`${name}: ${parsed.findings.length} findings`);
  }

  const { survivors, collapsed } = dedupeFindings(allFindings);
  const merged = renumberFindings(survivors);

  const outPath = path.join(dir, 'merged.json');
  fs.writeFileSync(outPath, `${JSON.stringify({ findings: merged }, null, 2)}\n`, 'utf8');

  lines.push('');
  lines.push(`duplicates collapsed: ${collapsed}`);
  lines.push(`final: ${merged.length} findings`);
  lines.push(`wrote: ${outPath}`);
  return { exitCode: 0, message: lines.join('\n') };
}

function printHelp() {
  console.log(`Usage: review merge --dir <path>

Merge tentative scout findings from every *.json file in the directory
(except merged.json) into a deduplicated, renumbered <dir>/merged.json.

Options:
  --dir <path>  Directory of scout tentative JSON files (required),
                e.g. .reviews/<id>-tentative/
  -h, --help    Show this help
`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = runMerge(opts);
    console.log(result.message);
    process.exit(result.exitCode);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
