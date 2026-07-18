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
 *   --lenses a,b,c      Comma list (default: all nine)
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
import { REVIEWS_DIR, LENSES, buildReviewSkeleton } from './lib.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    slug: null,
    type: 'branch',
    kind: 'review',
    description: '',
    lenses: [...LENSES],
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
    else if (arg === '--lenses') opts.lenses = splitList(argv[++i]);
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
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ now: Date, cwd?: string, gitImpl?: typeof captureGit }} ctx
 * @returns {{ exitCode: number; message: string; jsonPath?: string }}
 */
export function runNew(opts, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  if (!opts.slug) {
    return { exitCode: 1, message: 'a scope-slug positional argument is required' };
  }

  const git = opts.git ? (ctx.gitImpl ?? captureGit)(cwd, opts.baseBranch, opts.type) : {};

  let built;
  try {
    built = buildReviewSkeleton({
      slug: opts.slug,
      type: opts.type,
      kind: opts.kind,
      description: opts.description,
      lenses: opts.lenses,
      paths: opts.paths,
      parentReport: opts.parent ?? undefined,
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
    `  lenses:    ${opts.lenses.join(', ')}`,
    git.headSha ? `  head_sha:  ${git.headSha}` : '  head_sha:  (git capture skipped)',
    '',
    'Next: fill findings in the JSON, then:',
    `  review render --file ${path.relative(cwd, jsonPath)}`,
    '  review export',
  ].join('\n');

  return { exitCode: 0, message, jsonPath };
}

function printHelp() {
  console.log(`Usage: review new <scope-slug> [options]

Scaffold a schema-valid review JSON skeleton under .reviews/.

Options:
  --type <t>          uncommitted | branch | paths | commit_range | file (default: branch)
  --kind <k>          review | reverify (default: review)
  --description "..." Human scope description
  --lenses a,b,c      Comma list of lenses (default: all nine)
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
