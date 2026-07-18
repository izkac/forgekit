#!/usr/bin/env node
/**
 * Carry verified findings forward from a parent review into a newer report.
 *
 * A finding is carried only when the file it points at is unchanged between
 * the parent review's `scope.head_sha` and the current HEAD (and the file
 * actually exists at that SHA) — otherwise the finding is skipped with a
 * printed reason, because a re-verify against changed code is required.
 *
 * Carried findings get a fresh sequential F-### id continuing the target's
 * numbering, and their `verdict_reason` is prefixed with the provenance
 * (`Carried forward from <parent review_id> (unchanged since <sha8>): ...`).
 * The target's summary verdict tallies are recomputed and the result must
 * pass {@link validateReport} before anything is written.
 *
 * Usage:
 *   review carryforward --parent <reviewId|path> [options]
 *
 * Options:
 *   --parent <id|path>  Parent review id (resolved to .reviews/<id>-review.json)
 *                       or an explicit JSON path (required)
 *   --file <path>       Target review JSON (default: newest *-review.json in
 *                       .reviews/ that is not the parent and not kind=reverify)
 *   --dry-run           Print the carry/skip plan, write nothing
 *   --reviews-dir <dir> Reviews directory (default: .reviews)
 *   --repo <dir>        Git repo to diff against (default: cwd)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REVIEWS_DIR, ALL_VERDICTS, countByVerdict, validateReport } from './lib.mjs';

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    parent: null,
    file: null,
    dryRun: false,
    reviewsDir: REVIEWS_DIR,
    repo: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--parent') opts.parent = argv[++i];
    else if (arg === '--file') opts.file = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--reviews-dir') opts.reviewsDir = argv[++i];
    else if (arg === '--repo') opts.repo = argv[++i];
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
 * Next sequential F-### id continuing the given findings' numbering
 * (dup-### ids are ignored).
 *
 * @param {Array<{ id?: string }>} findings
 * @returns {string}
 */
export function nextFindingId(findings) {
  let max = 0;
  for (const f of findings) {
    const m = /^F-(\d{3})$/.exec(f.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `F-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Copy a parent finding into a carried finding: fresh id, provenance-prefixed
 * verdict_reason, everything else preserved.
 *
 * @param {Record<string, unknown>} finding
 * @param {{ id: string, parentReviewId: string, shortSha: string }} ctx
 * @returns {Record<string, unknown>}
 */
export function buildCarriedFinding(finding, ctx) {
  /** @type {Record<string, unknown>} */
  const carried = {
    id: ctx.id,
    lens: finding.lens,
    location: finding.location,
    claim: finding.claim,
    severity: finding.severity,
    verdict: finding.verdict,
    verdict_reason:
      `Carried forward from ${ctx.parentReviewId} (unchanged since ${ctx.shortSha}): ` +
      `${finding.verdict_reason ?? ''}`,
  };
  for (const key of ['title', 'evidence', 'original_severity', 'phase1_confidence']) {
    if (finding[key] !== undefined) carried[key] = finding[key];
  }
  return carried;
}

/**
 * Recompute the target's summary verdict tallies from its findings so it
 * reconciles with lib.mjs `validateSummary`: every verdict with a non-zero
 * tally (or an already-present key) is set to the actual count, and
 * `tentative_count` is bumped to at least the findings count. Non-count
 * summary fields (headline, top_actions, ...) are preserved.
 *
 * @param {Record<string, unknown>} report Mutated in place.
 */
export function recomputeSummary(report) {
  const summary = /** @type {Record<string, unknown>} */ (report.summary ?? {});
  const counts = countByVerdict(report);
  for (const verdict of ALL_VERDICTS) {
    if (counts[verdict] > 0 || summary[verdict] !== undefined) {
      summary[verdict] = counts[verdict];
    }
  }
  const findings = /** @type {unknown[]} */ (report.findings ?? []);
  const tentative = typeof summary.tentative_count === 'number' ? summary.tentative_count : 0;
  summary.tentative_count = Math.max(tentative, findings.length);
  report.summary = summary;
}

/**
 * Decide, per parent finding with a verdict, whether it carries into the
 * target or is skipped (and why). Pure apart from the injected git ops.
 *
 * @param {Record<string, unknown>} parentReport
 * @param {Record<string, unknown>} targetReport
 * @param {{
 *   fileChanged: (sha: string, file: string) => boolean,
 *   fileExistsAt: (sha: string, file: string) => boolean,
 * }} gitOps
 * @returns {{
 *   carries: Array<{ parentId: string, finding: Record<string, unknown> }>,
 *   skips: Array<{ parentId: string, reason: string }>,
 *   shortSha: string | null,
 * }}
 */
export function planCarries(parentReport, targetReport, gitOps) {
  const scope = /** @type {{ head_sha?: unknown }} */ (parentReport.scope ?? {});
  const headSha = typeof scope.head_sha === 'string' && scope.head_sha ? scope.head_sha : null;
  const shortSha = headSha ? headSha.slice(0, 8) : null;

  const parentFindings = /** @type {Array<Record<string, unknown>>} */ (
    parentReport.findings ?? []
  );
  const targetFindings = /** @type {Array<Record<string, unknown>>} */ (
    targetReport.findings ?? []
  );
  const present = new Set(targetFindings.map((f) => `${f.location}\u0000${f.claim}`));

  /** @type {Array<{ parentId: string, finding: Record<string, unknown> }>} */
  const carries = [];
  /** @type {Array<{ parentId: string, reason: string }>} */
  const skips = [];
  const numbered = [...targetFindings];

  for (const finding of parentFindings) {
    if (finding.verdict === undefined) continue;
    const parentId = /** @type {string} */ (finding.id ?? '(no id)');

    if (!headSha) {
      skips.push({ parentId, reason: 'parent report has no scope.head_sha' });
      continue;
    }
    if (present.has(`${finding.location}\u0000${finding.claim}`)) {
      skips.push({ parentId, reason: 'already present in target (same location and claim)' });
      continue;
    }

    const file = locationFile(/** @type {string} */ (finding.location ?? ''));
    let changed;
    try {
      changed = gitOps.fileChanged(headSha, file);
    } catch (err) {
      skips.push({ parentId, reason: `git error: ${/** @type {Error} */ (err).message}` });
      continue;
    }
    if (changed) {
      skips.push({ parentId, reason: `${file} changed since ${shortSha}` });
      continue;
    }
    if (!gitOps.fileExistsAt(headSha, file)) {
      skips.push({ parentId, reason: `${file} does not exist at parent head_sha ${shortSha}` });
      continue;
    }

    const carried = buildCarriedFinding(finding, {
      id: nextFindingId(numbered),
      parentReviewId: /** @type {string} */ (parentReport.review_id ?? '(unknown)'),
      shortSha: /** @type {string} */ (shortSha),
    });
    numbered.push(carried);
    present.add(`${carried.location}\u0000${carried.claim}`);
    carries.push({ parentId, finding: carried });
  }

  return { carries, skips, shortSha };
}

/**
 * Resolve `--parent` — a review id maps to `<reviewsDir>/<id>-review.json`,
 * anything that exists as a path is used verbatim.
 *
 * @param {string} parent
 * @param {string} reviewsDir
 * @param {string} cwd
 * @returns {string | null}
 */
function resolveParentPath(parent, reviewsDir, cwd) {
  const asPath = path.isAbsolute(parent) ? parent : path.resolve(cwd, parent);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return asPath;
  const asId = path.join(reviewsDir, `${parent}-review.json`);
  if (fs.existsSync(asId)) return asId;
  return null;
}

/**
 * Default target: newest `*-review.json` in the reviews dir that is not the
 * parent and whose `kind` is not `reverify`.
 *
 * @param {string} reviewsDir
 * @param {string} parentPath
 * @returns {string | null}
 */
function findDefaultTarget(reviewsDir, parentPath) {
  if (!fs.existsSync(reviewsDir)) return null;
  const candidates = fs
    .readdirSync(reviewsDir)
    .filter((name) => name.endsWith('-review.json'))
    .map((name) => path.join(reviewsDir, name))
    .filter((full) => path.resolve(full) !== path.resolve(parentPath))
    .filter((full) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        return parsed?.kind !== 'reverify';
      } catch {
        return false;
      }
    })
    .map((full) => ({ full, mtime: fs.statSync(full).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full ?? null;
}

/**
 * @param {string} repo
 * @returns {{ fileChanged: (sha: string, file: string) => boolean, fileExistsAt: (sha: string, file: string) => boolean }}
 */
function makeGitOps(repo) {
  return {
    fileChanged(sha, file) {
      // <sha> vs working tree (not <sha>..HEAD): uncommitted edits must block a carry
      // in this repo's commit-late workflow.
      const out = execFileSync('git', ['diff', '--name-only', sha, '--', file], {
        cwd: repo,
        encoding: 'utf8',
      });
      return out.trim() !== '';
    },
    fileExistsAt(sha, file) {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: repo, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * @param {string} jsonPath
 * @returns {{ ok: true, report: Record<string, unknown> } | { ok: false, message: string }}
 */
function loadReport(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    return { ok: false, message: `file not found: ${jsonPath}` };
  }
  try {
    return { ok: true, report: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) };
  } catch (err) {
    return { ok: false, message: `invalid JSON in ${jsonPath}: ${/** @type {Error} */ (err).message}` };
  }
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} [cwd]
 * @returns {{ exitCode: number; message: string }}
 */
export function runCarryforward(opts, cwd = process.cwd()) {
  if (!opts.parent) {
    return { exitCode: 1, message: '--parent <reviewId|path> is required' };
  }

  const reviewsDir = path.resolve(cwd, opts.reviewsDir ?? REVIEWS_DIR);
  const repo = opts.repo ? path.resolve(cwd, opts.repo) : cwd;

  const parentPath = resolveParentPath(opts.parent, reviewsDir, cwd);
  if (!parentPath) {
    return {
      exitCode: 1,
      message: `parent review not found: ${opts.parent} (looked for a file and for ${path.join(reviewsDir, `${opts.parent}-review.json`)})`,
    };
  }
  const parentLoaded = loadReport(parentPath);
  if (!parentLoaded.ok) return { exitCode: 1, message: parentLoaded.message };
  const parentReport = parentLoaded.report;

  const targetPath = opts.file
    ? path.isAbsolute(opts.file)
      ? opts.file
      : path.resolve(cwd, opts.file)
    : findDefaultTarget(reviewsDir, parentPath);
  if (!targetPath) {
    return { exitCode: 1, message: `no target review JSON found in ${reviewsDir}` };
  }
  const targetLoaded = loadReport(targetPath);
  if (!targetLoaded.ok) return { exitCode: 1, message: targetLoaded.message };
  const targetReport = targetLoaded.report;

  const plan = planCarries(parentReport, targetReport, makeGitOps(repo));

  const lines = [`parent: ${parentPath}`, `target: ${targetPath}`, ''];
  for (const c of plan.carries) {
    lines.push(`CARRY ${c.parentId} -> ${c.finding.id}  ${c.finding.location}`);
  }
  for (const s of plan.skips) {
    lines.push(`SKIP  ${s.parentId}  ${s.reason}`);
  }
  lines.push('');
  lines.push(`${plan.carries.length} carried, ${plan.skips.length} skipped`);

  if (opts.dryRun) {
    lines.push('(dry-run — nothing written)');
    return { exitCode: 0, message: lines.join('\n') };
  }

  if (plan.carries.length > 0) {
    const findings = /** @type {Array<Record<string, unknown>>} */ (targetReport.findings ?? []);
    targetReport.findings = [...findings, ...plan.carries.map((c) => c.finding)];
    recomputeSummary(targetReport);

    const validation = validateReport(targetReport);
    if (!validation.ok) {
      return {
        exitCode: 1,
        message: `refusing to write ${targetPath} — validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`,
      };
    }

    fs.writeFileSync(targetPath, `${JSON.stringify(targetReport, null, 2)}\n`, 'utf8');
    lines.push(`wrote: ${targetPath}`);
  }

  return { exitCode: 0, message: lines.join('\n') };
}

function printHelp() {
  console.log(`Usage: review carryforward --parent <reviewId|path> [options]

Carry verified findings forward from a parent review into a newer report,
for findings whose files are unchanged since the parent's head SHA.

Options:
  --parent <id|path>  Parent review id (resolves to .reviews/<id>-review.json)
                      or an explicit JSON path (required)
  --file <path>       Target review JSON (default: newest *-review.json in
                      .reviews/ that is not the parent and not kind=reverify)
  --dry-run           Print the carry/skip plan, write nothing
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
    const result = runCarryforward(opts);
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
