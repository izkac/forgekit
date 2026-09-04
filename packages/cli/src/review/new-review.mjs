#!/usr/bin/env node
/**
 * Scaffold a new thorough-code-review JSON sidecar under `.reviews/`.
 *
 * Removes the hand-generated-timestamp / slug / git-SHA failure mode: this
 * stamps the canonical ISO-UTC time, derives the review id, captures base/head
 * SHAs from git, and writes a schema-valid skeleton with empty findings. The
 * agent then fills in findings and runs `review:render` + `review:export`.
 *
 * Usage:
 *   review new <scope-slug> [options]
 *
 * Options:
 *   --type <t>          uncommitted | branch | paths | commit_range | file
 *   --kind <k>          review | reverify          (default: review)
 *   --description "..." Human scope description
 *   --preset <p>        quick | standard | deep | auto   (default: auto)
 *   --lenses a,b,c      Comma list (default: the preset's lenses)
 *   --all-lenses        All nine lenses
 *   --paths p1,p2       Comma list of scoped paths
 *   --parent <id>       Parent review_id (required for --kind reverify)
 *   --base-branch <b>   Merge-base branch for --type branch (default: main)
 *   --reviews-dir <dir> Output dir (default: .reviews)
 *   --no-git            Skip git SHA capture
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  REVIEWS_DIR,
  LENSES,
  PRESETS,
  PRESET_NAMES,
  QUICK_LINE_BUDGET,
  buildReviewSkeleton,
} from './lib.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    slug: null,
    type: 'branch',
    kind: 'review',
    description: '',
    preset: 'auto',
    lenses: /** @type {string[] | null} */ (null),
    allLenses: false,
    paths: /** @type {string[]} */ ([]),
    parent: null,
    baseBranch: 'main',
    reviewsDir: REVIEWS_DIR,
    git: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--type') opts.type = argv[++i];
    else if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--description') opts.description = argv[++i];
    else if (arg === '--preset') opts.preset = argv[++i];
    else if (arg === '--lenses') opts.lenses = splitList(argv[++i]);
    else if (arg === '--all-lenses') opts.allLenses = true;
    else if (arg === '--paths') opts.paths = splitList(argv[++i]);
    else if (arg === '--parent') opts.parent = argv[++i];
    else if (arg === '--base-branch') opts.baseBranch = argv[++i];
    else if (arg === '--reviews-dir') opts.reviewsDir = argv[++i];
    else if (arg === '--no-git') opts.git = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    else if (opts.slug == null) opts.slug = arg;
    else throw new Error(`unexpected positional argument: ${arg}`);
  }

  return opts;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {string} baseBranch
 * @param {('uncommitted'|'branch'|'paths'|'commit_range'|'file')} type
 * @returns {{ baseSha?: string, headSha?: string }}
 */
function captureGit(cwd, baseBranch, type) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  /** @type {{ baseSha?: string, headSha?: string }} */
  const out = {};
  try {
    out.headSha = run(['rev-parse', 'HEAD']);
  } catch {
    return out;
  }
  if (type === 'branch') {
    try {
      out.baseSha = run(['merge-base', baseBranch, 'HEAD']);
    } catch {
      /* base branch may not exist locally — leave undefined */
    }
  }
  return out;
}

/**
/**
 * Added + deleted lines in the scope, or `null` when git cannot answer (no
 * repo, unmeasurable scope type, binary-only diff).
 *
 * @param {string} cwd
 * @param {string} type
 * @param {string} baseBranch
 * @returns {number | null}
 */
export function countChangedLines(cwd, type, baseBranch) {
  const args =
    type === 'branch'
      ? ['diff', '--numstat', `${baseBranch}...HEAD`]
      : type === 'uncommitted'
        ? ['diff', '--numstat', 'HEAD']
        : null;
  if (!args) return null;
  let out;
  try {
    out = execFileSync('git', args, { cwd, encoding: 'utf8' });
  } catch {
    return null;
  }
  let total = 0;
  for (const line of out.split('\n')) {
    const [added, deleted] = line.split('\t');
    // Binary files report '-' for both counts; they carry no reviewable lines.
    if (added === undefined || added === '-') continue;
    total += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return total;
}

/**
 * Resolve `auto` from the size of the change: small diffs get `quick`, bigger
 * or unmeasurable ones get `standard`. `deep` is never automatic — the full
 * nine-lens pipeline is a deliberate purchase, not a default.
 *
 * @param {string} requested
 * @param {number | null} changedLines
 * @returns {{ preset: 'quick'|'standard'|'deep', reason: string }}
 */
export function resolvePreset(requested, changedLines) {
  if (requested !== 'auto') {
    if (!PRESET_NAMES.includes(requested)) {
      throw new Error(`unknown preset: ${requested} (expected ${PRESET_NAMES.join('|')}|auto)`);
    }
    return { preset: /** @type {'quick'|'standard'|'deep'} */ (requested), reason: 'requested' };
  }
  if (changedLines === null) {
    return { preset: 'standard', reason: 'scope size unmeasurable — failing closed to standard' };
  }
  if (changedLines <= QUICK_LINE_BUDGET) {
    return { preset: 'quick', reason: `${changedLines} changed line(s) <= ${QUICK_LINE_BUDGET}` };
  }
  return { preset: 'standard', reason: `${changedLines} changed line(s) > ${QUICK_LINE_BUDGET}` };
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ now: Date, cwd?: string, gitImpl?: typeof captureGit, linesImpl?: typeof countChangedLines }} ctx
 * @returns {{ exitCode: number; message: string; jsonPath?: string }}
 */
export function runNew(opts, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  if (!opts.slug) {
    return { exitCode: 1, message: 'a scope-slug positional argument is required' };
  }

  const git = opts.git ? (ctx.gitImpl ?? captureGit)(cwd, opts.baseBranch, opts.type) : {};

  /** @type {{ preset: 'quick'|'standard'|'deep', reason: string }} */
  let resolved;
  try {
    const changedLines =
      opts.preset === 'auto' && opts.git
        ? (ctx.linesImpl ?? countChangedLines)(cwd, opts.type, opts.baseBranch)
        : null;
    resolved = resolvePreset(opts.preset, changedLines);
  } catch (err) {
    return { exitCode: 1, message: /** @type {Error} */ (err).message };
  }
  const policy = PRESETS[resolved.preset];
  // Explicit --lenses wins; --all-lenses is the nine-lens shorthand; else the
  // preset decides (defect lenses, or all nine for deep).
  const lenses = opts.lenses ?? (opts.allLenses ? [...LENSES] : [...policy.lenses]);

  let built;
  try {
    built = buildReviewSkeleton({
      slug: opts.slug,
      type: opts.type,
      kind: opts.kind,
      description: opts.description,
      lenses,
      paths: opts.paths,
      parentReport: opts.parent ?? undefined,
      preset: resolved.preset,
      baseSha: git.baseSha,
      headSha: git.headSha,
      now: ctx.now,
    });
  } catch (err) {
    return { exitCode: 1, message: /** @type {Error} */ (err).message };
  }

  const reviewsDir = path.resolve(cwd, opts.reviewsDir ?? REVIEWS_DIR);
  fs.mkdirSync(reviewsDir, { recursive: true });
  const jsonPath = path.join(reviewsDir, `${built.fileBase}.json`);

  if (fs.existsSync(jsonPath)) {
    return { exitCode: 1, message: `refusing to overwrite existing report: ${jsonPath}` };
  }

  fs.writeFileSync(jsonPath, `${JSON.stringify(built.report, null, 2)}\n`, 'utf8');

  const message = [
    `Scaffolded review: ${jsonPath}`,
    `  review_id: ${built.reviewId}`,
    `  preset:    ${resolved.preset} (${resolved.reason})`,
    `  lenses:    ${lenses.join(', ')}`,
    git.headSha ? `  head_sha:  ${git.headSha}` : '  head_sha:  (git capture skipped)',
    '',
    `Dispatch policy for preset "${resolved.preset}" — do not exceed:`,
    `  scouts:          ${policy.scouts} (partition the scope; grow units, not the count)`,
    `  skeptic budget:  ${policy.skeptic_budget} dispatches (dedicated + batched + second opinions)`,
    `  verify from:     ${policy.verify_from} and above`,
    '  below that:      verdict "unverified" with the scout evidence — no dispatch',
    `  second opinions: ${policy.second_opinions} max (dismissed critical only)`,
    '',
    'Next: fill findings in the JSON, then:',
    `  review render --file ${path.relative(cwd, jsonPath)}`,
    '  review export',
  ].join('\n');

  return { exitCode: 0, message, jsonPath, preset: resolved.preset };
}

function printHelp() {
  console.log(`Usage: review new <scope-slug> [options]

Scaffold a schema-valid review JSON skeleton under .reviews/.

Options:
  --type <t>          uncommitted | branch | paths | commit_range | file (default: branch)
  --kind <k>          review | reverify (default: review)
  --description "..." Human scope description
  --preset <p>        quick | standard | deep | auto (default: auto — size-resolved)
  --lenses a,b,c      Comma list of lenses (default: the preset's lenses)
  --all-lenses        All nine lenses
  --paths p1,p2       Comma list of scoped paths
  --parent <id>       Parent review_id (required for --kind reverify)
  --base-branch <b>   Merge-base branch for --type branch (default: main)
  --reviews-dir <dir> Output directory (default: .reviews)
  --no-git            Skip git SHA capture
  -h, --help          Show this help
`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = runNew(opts, { now: new Date() });
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
