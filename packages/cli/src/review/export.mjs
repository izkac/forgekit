#!/usr/bin/env node
/**
 * Export and validate thorough code review JSON sidecars for CI.
 *
 * Usage:
 *   review export [--file <json>] [--out <dir>] [--fail-on critical]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REVIEWS_DIR,
  findLatestReviewJson,
  formatSummary,
  countOpenAtOrAbove,
  renderMarkdown,
  validateReport,
} from './lib.mjs';

const FAIL_ON_LEVELS = new Set(['critical', 'important', 'minor']);

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    file: null,
    out: null,
    failOn: null,
    failOnCritical: false,
    renderMd: false,
    reviewsDir: REVIEWS_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') {
      opts.file = argv[++i];
    } else if (arg === '--out') {
      opts.out = argv[++i];
    } else if (arg === '--render-md') {
      opts.renderMd = true;
    } else if (arg === '--fail-on') {
      const level = argv[++i];
      if (!FAIL_ON_LEVELS.has(level)) {
        throw new Error(`unsupported --fail-on value: ${level} (expected critical|important|minor)`);
      }
      opts.failOn = level;
      opts.failOnCritical = level === 'critical';
    } else if (arg === '--reviews-dir') {
      opts.reviewsDir = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return opts;
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @returns {{ exitCode: number; message: string }}
 */
export function runExport(opts, cwd = process.cwd()) {
  const reviewsDir = path.resolve(cwd, opts.reviewsDir ?? REVIEWS_DIR);
  const jsonPath = opts.file
    ? path.isAbsolute(opts.file)
      ? opts.file
      : path.resolve(cwd, opts.file)
    : findLatestReviewJson(reviewsDir);

  if (!jsonPath) {
    return { exitCode: 1, message: `no review JSON found in ${reviewsDir}` };
  }

  if (!fs.existsSync(jsonPath)) {
    return { exitCode: 1, message: `file not found: ${jsonPath}` };
  }

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
      message: `validation failed for ${jsonPath}:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
    };
  }

  const report = validation.report;
  const lines = [`OK ${jsonPath}`, formatSummary(report)];

  if (opts.renderMd) {
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    fs.writeFileSync(mdPath, `${renderMarkdown(report)}\n`, 'utf8');
    lines.push(`rendered: ${mdPath}`);
  }

  if (opts.out) {
    const outDir = path.resolve(cwd, opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(jsonPath);
    const mdBase = base.replace(/\.json$/, '.md');
    const jsonDest = path.join(outDir, base);
    const mdSrc = path.join(path.dirname(jsonPath), mdBase);
    fs.copyFileSync(jsonPath, jsonDest);
    if (fs.existsSync(mdSrc)) {
      fs.copyFileSync(mdSrc, path.join(outDir, mdBase));
      lines.push(`copied: ${jsonDest}, ${path.join(outDir, mdBase)}`);
    } else {
      lines.push(`copied: ${jsonDest} (no paired .md at ${mdSrc})`);
    }
  }

  const failLevel = opts.failOn ?? (opts.failOnCritical ? 'critical' : null);
  if (failLevel) {
    const openCount = countOpenAtOrAbove(report, failLevel);
    if (openCount > 0) {
      lines.push(`FAIL: ${openCount} open ${failLevel}+ finding(s)`);
      return { exitCode: 1, message: lines.join('\n') };
    }
  }

  return { exitCode: 0, message: lines.join('\n') };
}

function printHelp() {
  console.log(`Usage: review export [options]

Options:
  --file <path>       Review JSON (default: latest *-review.json in .reviews/)
  --out <dir>         Copy JSON (+ paired .md if present) to directory
  --render-md         (Re)generate the paired Markdown from the JSON first
  --fail-on <level>   Exit 1 if any open finding at/above level remains
                      (critical | important | minor)
  --reviews-dir <dir> Reviews directory (default: .reviews)
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
    const result = runExport(opts);
    console.log(result.message);
    process.exit(result.exitCode);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
