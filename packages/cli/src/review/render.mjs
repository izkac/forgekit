#!/usr/bin/env node
/**
 * Render the human-readable Markdown report from a review JSON sidecar.
 *
 * JSON is the single source of truth; this regenerates the paired `.md` so the
 * two can never drift. Validates before rendering.
 *
 * Usage:
 *   review render [--file <json>] [--reviews-dir <dir>] [--stdout]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REVIEWS_DIR, findLatestReviewJson, renderMarkdown, validateReport } from './lib.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = { file: null, reviewsDir: REVIEWS_DIR, stdout: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') opts.file = argv[++i];
    else if (arg === '--reviews-dir') opts.reviewsDir = argv[++i];
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @returns {{ exitCode: number; message: string }}
 */
export function runRender(opts, cwd = process.cwd()) {
  const reviewsDir = path.resolve(cwd, opts.reviewsDir ?? REVIEWS_DIR);
  const jsonPath = opts.file
    ? path.isAbsolute(opts.file)
      ? opts.file
      : path.resolve(cwd, opts.file)
    : findLatestReviewJson(reviewsDir);

  if (!jsonPath) return { exitCode: 1, message: `no review JSON found in ${reviewsDir}` };
  if (!fs.existsSync(jsonPath)) return { exitCode: 1, message: `file not found: ${jsonPath}` };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    return { exitCode: 1, message: `invalid JSON: ${/** @type {Error} */ (err).message}` };
  }

  const validation = validateReport(parsed);
  if (!validation.ok) {
    return {
      exitCode: 1,
      message: `validation failed for ${jsonPath}:\n${validation.errors
        .map((e) => `  - ${e}`)
        .join('\n')}`,
    };
  }

  const md = `${renderMarkdown(validation.report)}\n`;
  if (opts.stdout) return { exitCode: 0, message: md };

  const mdPath = jsonPath.replace(/\.json$/, '.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  return { exitCode: 0, message: `rendered: ${mdPath}` };
}

function printHelp() {
  console.log(`Usage: review render [options]

Regenerates the paired Markdown from a review JSON sidecar.

Options:
  --file <path>       Review JSON (default: latest *-review.json in .reviews/)
  --reviews-dir <dir> Reviews directory (default: .reviews)
  --stdout            Print Markdown to stdout instead of writing the .md file
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
    const result = runRender(opts);
    process.stdout.write(result.message.endsWith('\n') ? result.message : `${result.message}\n`);
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
