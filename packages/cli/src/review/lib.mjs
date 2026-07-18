#!/usr/bin/env node
/**
 * Shared validation, discovery, scaffolding, and rendering for the thorough
 * code review export pipeline.
 *
 * JSON is the single source of truth for a review. The paired Markdown is
 * *generated* from the JSON (see {@link renderMarkdown}) so the two can never
 * drift. The contract is mirrored in
 * `.cursor/skills/thorough-code-review/reference/report-schema.json` in product
 * repos, or forgekit `skills/thorough-code-review/reference/report-schema.json`;
 * the `schema-consistency.test.mjs` test asserts the enums below stay in sync with
 * that file.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LENSES = [
  'security',
  'correctness',
  'smells',
  'architecture',
  'performance',
  'tests',
  'contracts',
  'errors',
  'maintainability',
];

export const SCOPE_TYPES = ['uncommitted', 'branch', 'paths', 'commit_range', 'file'];

export const SEVERITIES = ['critical', 'important', 'minor'];

/** Severity ordering, high → low, for graded `--fail-on` gates. */
export const SEVERITY_RANK = { critical: 3, important: 2, minor: 1 };

export const INITIAL_VERDICTS = ['confirmed', 'false_positive', 'downgraded', 'needs_decision'];

export const REVERIFY_VERDICTS = ['resolved', 'still_open', 'partially_fixed', 'regressed'];

export const ALL_VERDICTS = [...INITIAL_VERDICTS, ...REVERIFY_VERDICTS];

/** Verdicts that count as an unresolved, still-actionable issue. */
export const OPEN_VERDICTS = ['confirmed', 'downgraded', 'still_open', 'partially_fixed', 'regressed'];

export const CONFIDENCES = ['low', 'medium', 'high'];

/** Allowed keys for the optional pipeline `stats` object (all non-negative integers). */
export const STATS_KEYS = [
  'scouts',
  'skeptics_dedicated',
  'skeptics_batched',
  'inline_verdicts',
  'grounded_skips',
  'carried_forward',
  'second_opinions',
];

const LENS_SET = new Set(LENSES);
const SCOPE_TYPE_SET = new Set(SCOPE_TYPES);
const SEVERITY_SET = new Set(SEVERITIES);
const INITIAL_VERDICT_SET = new Set(INITIAL_VERDICTS);
const REVERIFY_VERDICT_SET = new Set(REVERIFY_VERDICTS);
const ALL_VERDICT_SET = new Set(ALL_VERDICTS);
const CONFIDENCE_SET = new Set(CONFIDENCES);
const STATS_KEY_SET = new Set(STATS_KEYS);

const FINDING_ID = /^(F|dup)-[0-9]{3}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const REVIEWS_DIR = '.reviews';

/**
 * @param {unknown} report
 * @returns {{ ok: true, report: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateReport(report) {
  const errors = [];

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['root must be an object'] };
  }

  const r = /** @type {Record<string, unknown>} */ (report);

  requireString(r, 'review_id', errors);
  requireEnum(r, 'kind', new Set(['review', 'reverify']), errors);
  requireIsoTimestamp(r, 'created_at', errors);

  if (!r.scope || typeof r.scope !== 'object' || Array.isArray(r.scope)) {
    errors.push('scope must be an object');
  } else {
    const scope = /** @type {Record<string, unknown>} */ (r.scope);
    requireEnum(scope, 'type', SCOPE_TYPE_SET, errors, 'scope');
    requireString(scope, 'description', errors, 'scope');
    if (scope.paths !== undefined) {
      if (!Array.isArray(scope.paths) || scope.paths.some((p) => typeof p !== 'string')) {
        errors.push('scope.paths must be an array of strings');
      }
    }
  }

  if (!Array.isArray(r.lenses) || r.lenses.length < 1) {
    errors.push('lenses must be a non-empty array');
  } else if (r.lenses.some((l) => typeof l !== 'string' || !LENS_SET.has(l))) {
    errors.push(`lenses entries must be one of: ${LENSES.join(', ')}`);
  }

  if (r.parent_report !== undefined && typeof r.parent_report !== 'string') {
    errors.push('parent_report must be a string when present');
  }

  if (r.kind === 'reverify' && typeof r.parent_report !== 'string') {
    errors.push('reverify reports require parent_report');
  }

  if (!r.summary || typeof r.summary !== 'object' || Array.isArray(r.summary)) {
    errors.push('summary must be an object');
  } else {
    validateSummary(/** @type {Record<string, unknown>} */ (r.summary), r.findings, errors);
  }

  if (!Array.isArray(r.findings)) {
    errors.push('findings must be an array');
  } else {
    r.findings.forEach((f, i) => validateFinding(f, i, errors, r.kind));
  }

  if (r.dedupe_preflight !== undefined) {
    validateDedupePreflight(r.dedupe_preflight, errors);
  }

  if (r.coverage !== undefined) {
    validateCoverage(r.coverage, errors);
  }

  if (r.signals !== undefined) {
    validateSignals(r.signals, errors);
  }

  if (r.stats !== undefined) {
    validateStats(r.stats, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, report: r };
}

/**
 * Reconciles the summary's verdict tallies against the actual findings so a
 * hand-edited report cannot claim counts that disagree with its own body.
 *
 * @param {Record<string, unknown>} summary
 * @param {unknown} findings
 * @param {string[]} errors
 */
function validateSummary(summary, findings, errors) {
  if (typeof summary.tentative_count !== 'number' || summary.tentative_count < 0) {
    errors.push('summary.tentative_count must be a non-negative number');
  }

  if (!Array.isArray(findings)) {
    return; // findings errors reported separately
  }

  if (
    typeof summary.tentative_count === 'number' &&
    summary.tentative_count < findings.length
  ) {
    errors.push(
      `summary.tentative_count (${summary.tentative_count}) must be >= findings count (${findings.length})`,
    );
  }

  const actual = countByVerdict({ findings });
  for (const verdict of ALL_VERDICTS) {
    const claimed = summary[verdict];
    if (claimed === undefined) {
      if (actual[verdict] > 0) {
        errors.push(
          `summary.${verdict} missing but ${actual[verdict]} finding(s) have that verdict`,
        );
      }
      continue;
    }
    if (typeof claimed !== 'number' || claimed !== actual[verdict]) {
      errors.push(
        `summary.${verdict} (${String(claimed)}) does not match findings tally (${actual[verdict]})`,
      );
    }
  }
}

/**
 * @param {unknown} finding
 * @param {number} index
 * @param {string[]} errors
 * @param {unknown} kind
 */
function validateFinding(finding, index, errors, kind) {
  const prefix = `findings[${index}]`;

  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  const f = /** @type {Record<string, unknown>} */ (finding);

  if (typeof f.id !== 'string' || !FINDING_ID.test(f.id)) {
    errors.push(`${prefix}.id must match F-### or dup-###`);
  }
  if (typeof f.lens !== 'string' || !LENS_SET.has(f.lens)) {
    errors.push(`${prefix}.lens invalid`);
  }
  requireString(f, 'location', errors, prefix);
  requireString(f, 'claim', errors, prefix);
  if (typeof f.severity !== 'string' || !SEVERITY_SET.has(f.severity)) {
    errors.push(`${prefix}.severity must be critical|important|minor`);
  }
  if (typeof f.verdict !== 'string' || !ALL_VERDICT_SET.has(f.verdict)) {
    errors.push(`${prefix}.verdict invalid`);
  }
  requireString(f, 'verdict_reason', errors, prefix);

  // Optional fields — validated when present so the JSON schema and runtime
  // validator agree on more than just the required core.
  if (f.title !== undefined && (typeof f.title !== 'string' || f.title.length < 1)) {
    errors.push(`${prefix}.title must be a non-empty string when present`);
  }
  if (f.evidence !== undefined && typeof f.evidence !== 'string') {
    errors.push(`${prefix}.evidence must be a string when present`);
  }
  if (
    f.phase1_confidence !== undefined &&
    (typeof f.phase1_confidence !== 'string' || !CONFIDENCE_SET.has(f.phase1_confidence))
  ) {
    errors.push(`${prefix}.phase1_confidence must be low|medium|high when present`);
  }
  if (
    f.original_severity !== undefined &&
    (typeof f.original_severity !== 'string' || !SEVERITY_SET.has(f.original_severity))
  ) {
    errors.push(`${prefix}.original_severity must be critical|important|minor when present`);
  }
  if (f.verdict === 'downgraded' && typeof f.original_severity !== 'string') {
    errors.push(`${prefix}.original_severity is required when verdict=downgraded`);
  }
  if (f.second_opinion !== undefined) {
    validateSecondOpinion(f.second_opinion, `${prefix}.second_opinion`, errors);
  }

  if (kind === 'review' && typeof f.verdict === 'string' && REVERIFY_VERDICT_SET.has(f.verdict)) {
    errors.push(`${prefix}.verdict ${f.verdict} not valid for kind=review`);
  }
  if (kind === 'reverify' && typeof f.verdict === 'string' && INITIAL_VERDICT_SET.has(f.verdict)) {
    errors.push(`${prefix}.verdict ${f.verdict} not valid for kind=reverify`);
  }
}

/**
 * A risk-weighted second skeptic opinion recorded for dangerous-quadrant findings.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @param {string[]} errors
 */
function validateSecondOpinion(value, prefix, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const s = /** @type {Record<string, unknown>} */ (value);
  if (typeof s.verdict !== 'string' || !ALL_VERDICT_SET.has(s.verdict)) {
    errors.push(`${prefix}.verdict invalid`);
  }
  requireString(s, 'verdict_reason', errors, prefix);
  if (s.agrees !== undefined && typeof s.agrees !== 'boolean') {
    errors.push(`${prefix}.agrees must be a boolean when present`);
  }
}

/**
 * @param {unknown} dedupe
 * @param {string[]} errors
 */
function validateDedupePreflight(dedupe, errors) {
  if (!dedupe || typeof dedupe !== 'object' || Array.isArray(dedupe)) {
    errors.push('dedupe_preflight must be an object');
    return;
  }
  const d = /** @type {Record<string, unknown>} */ (dedupe);
  if (typeof d.count !== 'number' || d.count < 0) {
    errors.push('dedupe_preflight.count must be a non-negative number');
  }
}

/**
 * The coverage ledger from the recall/completeness pass: which files were
 * actually reviewed, which were skipped, and which active lenses produced no
 * findings (with a justification each).
 *
 * @param {unknown} coverage
 * @param {string[]} errors
 */
function validateCoverage(coverage, errors) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    errors.push('coverage must be an object');
    return;
  }
  const c = /** @type {Record<string, unknown>} */ (coverage);
  for (const key of ['files_reviewed', 'files_skipped']) {
    if (c[key] !== undefined && (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== 'string'))) {
      errors.push(`coverage.${key} must be an array of strings when present`);
    }
  }
  if (c.lenses_without_findings !== undefined) {
    if (!Array.isArray(c.lenses_without_findings)) {
      errors.push('coverage.lenses_without_findings must be an array when present');
    } else {
      c.lenses_without_findings.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`coverage.lenses_without_findings[${i}] must be an object`);
          return;
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (typeof e.lens !== 'string' || !LENS_SET.has(e.lens)) {
          errors.push(`coverage.lenses_without_findings[${i}].lens invalid`);
        }
        if (typeof e.reason !== 'string' || e.reason.length < 1) {
          errors.push(`coverage.lenses_without_findings[${i}].reason must be a non-empty string`);
        }
      });
    }
  }
}

/**
 * The signals pre-flight summary: which deterministic tools were run and what
 * they reported, so the scout's grounded findings are auditable.
 *
 * @param {unknown} signals
 * @param {string[]} errors
 */
function validateSignals(signals, errors) {
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) {
    errors.push('signals must be an object');
    return;
  }
  const s = /** @type {Record<string, unknown>} */ (signals);
  if (s.tools !== undefined) {
    if (!Array.isArray(s.tools)) {
      errors.push('signals.tools must be an array when present');
    } else {
      s.tools.forEach((tool, i) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
          errors.push(`signals.tools[${i}] must be an object`);
          return;
        }
        const t = /** @type {Record<string, unknown>} */ (tool);
        if (typeof t.name !== 'string' || t.name.length < 1) {
          errors.push(`signals.tools[${i}].name must be a non-empty string`);
        }
        if (t.status !== undefined && !['pass', 'fail', 'skipped'].includes(/** @type {string} */ (t.status))) {
          errors.push(`signals.tools[${i}].status must be pass|fail|skipped when present`);
        }
      });
    }
  }
}

/**
 * Pipeline stats: how many subagents ran and which shortcuts fired, so the
 * cost/depth of a review run is auditable from the report itself.
 *
 * @param {unknown} stats
 * @param {string[]} errors
 */
function validateStats(stats, errors) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    errors.push('stats must be an object');
    return;
  }
  const s = /** @type {Record<string, unknown>} */ (stats);
  for (const [key, value] of Object.entries(s)) {
    if (!STATS_KEY_SET.has(key)) {
      errors.push(`stats.${key} is not a known stats key (expected ${STATS_KEYS.join(', ')})`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      errors.push(`stats.${key} must be a non-negative integer`);
    }
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string[]} errors
 * @param {string} [prefix]
 */
function requireString(obj, key, errors, prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  if (typeof obj[key] !== 'string' || obj[key].length < 1) {
    errors.push(`${p}${key} must be a non-empty string`);
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string[]} errors
 */
function requireIsoTimestamp(obj, key, errors) {
  const v = obj[key];
  if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
    errors.push(`${key} must be an ISO-8601 UTC timestamp (e.g. 2026-06-05T16:00:00.000Z)`);
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {Set<string>} allowed
 * @param {string[]} errors
 * @param {string} [prefix]
 */
function requireEnum(obj, key, allowed, errors, prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  if (typeof obj[key] !== 'string' || !allowed.has(obj[key])) {
    errors.push(`${p}${key} must be one of: ${[...allowed].join(', ')}`);
  }
}

/**
 * @param {string} reviewsDir
 * @returns {string | null}
 */
export function findLatestReviewJson(reviewsDir) {
  if (!fs.existsSync(reviewsDir)) {
    return null;
  }

  const candidates = fs
    .readdirSync(reviewsDir)
    .filter((name) => name.endsWith('-review.json') && !name.endsWith('-reverify.json'))
    .map((name) => {
      const full = path.join(reviewsDir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return candidates[0]?.full ?? null;
}

/**
 * @param {Record<string, unknown>} report
 * @returns {Record<string, number>}
 */
export function countByVerdict(report) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const v of ALL_VERDICTS) counts[v] = 0;

  const findings = /** @type {Array<{ verdict?: string }>} */ (report.findings ?? []);
  for (const f of findings) {
    const v = f.verdict;
    if (v && v in counts) {
      counts[v] += 1;
    }
  }

  return counts;
}

/**
 * Count open findings at or above a severity level. `null` level counts all open.
 *
 * @param {Record<string, unknown>} report
 * @param {('critical'|'important'|'minor')} [level]
 * @returns {number}
 */
export function countOpenAtOrAbove(report, level = 'critical') {
  const findings = /** @type {Array<{ severity?: string; verdict?: string }>} */ (
    report.findings ?? []
  );
  const openVerdicts = new Set(OPEN_VERDICTS);
  const threshold = SEVERITY_RANK[level] ?? SEVERITY_RANK.critical;

  return findings.filter(
    (f) =>
      f.verdict &&
      openVerdicts.has(f.verdict) &&
      f.severity != null &&
      (SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (f.severity)] ?? 0) >= threshold,
  ).length;
}

/**
 * @param {Record<string, unknown>} report
 * @returns {number}
 */
export function countOpenCritical(report) {
  return countOpenAtOrAbove(report, 'critical');
}

/**
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function formatSummary(report) {
  const verdicts = countByVerdict(report);
  const scope = /** @type {{ description?: string }} */ (report.scope ?? {});
  const lines = [
    `review_id: ${report.review_id}`,
    `kind: ${report.kind}`,
    `scope: ${scope.description ?? '(unknown)'}`,
    `lenses: ${(/** @type {string[]} */ (report.lenses)).join(', ')}`,
    `findings: ${(/** @type {unknown[]} */ (report.findings)).length}`,
    `confirmed: ${verdicts.confirmed}`,
    `false_positive: ${verdicts.false_positive}`,
    `needs_decision: ${verdicts.needs_decision}`,
    `open_critical: ${countOpenCritical(report)}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/**
 * Convert a Date to the canonical compact UTC stamp used in review ids,
 * e.g. 2026-06-05T16:00:00.000Z → 20260605T160000Z.
 *
 * @param {Date} date
 * @returns {string}
 */
export function compactStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Normalize a free-text scope into a filesystem-safe slug.
 *
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'review';
}

/**
 * Build a minimal but schema-valid review skeleton. CLI wrappers add git SHAs.
 *
 * @param {{
 *   slug: string,
 *   type?: ('uncommitted'|'branch'|'paths'|'commit_range'|'file'),
 *   kind?: ('review'|'reverify'),
 *   description?: string,
 *   lenses?: string[],
 *   paths?: string[],
 *   parentReport?: string,
 *   baseSha?: string,
 *   headSha?: string,
 *   now: Date,
 * }} opts
 * @returns {{ reviewId: string, fileBase: string, report: Record<string, unknown> }}
 */
export function buildReviewSkeleton(opts) {
  const {
    slug,
    type = 'branch',
    kind = 'review',
    description = '',
    lenses = LENSES,
    paths,
    parentReport,
    baseSha,
    headSha,
    now,
  } = opts;

  if (!SCOPE_TYPE_SET.has(type)) {
    throw new Error(`unknown scope type: ${type} (expected ${SCOPE_TYPES.join('|')})`);
  }
  if (kind !== 'review' && kind !== 'reverify') {
    throw new Error(`unknown kind: ${kind} (expected review|reverify)`);
  }
  if (kind === 'reverify' && !parentReport) {
    throw new Error('reverify skeletons require parentReport');
  }
  const cleanSlug = slugify(slug);
  const stamp = compactStamp(now);
  const reviewId = `${stamp}-${cleanSlug}`;
  const fileBase = `${reviewId}-${kind === 'reverify' ? 'reverify' : 'review'}`;

  /** @type {Record<string, unknown>} */
  const scope = { type, description: description || `${type} — ${cleanSlug}` };
  if (baseSha) scope.base_sha = baseSha;
  if (headSha) scope.head_sha = headSha;
  if (paths && paths.length > 0) scope.paths = paths;

  /** @type {Record<string, unknown>} */
  const report = {
    review_id: reviewId,
    kind,
    created_at: now.toISOString(),
    scope,
    lenses: [...lenses],
    summary: { tentative_count: 0 },
    findings: [],
  };
  if (parentReport) report.parent_report = parentReport;

  return { reviewId, fileBase, report };
}

// ---------------------------------------------------------------------------
// Rendering — Markdown is generated from the JSON, never hand-authored.
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'important', 'minor'];

/** Verdicts shown in the main body, per report kind. */
const MAIN_BODY_VERDICTS = {
  review: new Set(['confirmed', 'downgraded']),
  reverify: new Set(['still_open', 'partially_fixed', 'regressed']),
};

/**
 * @param {{ id?: string, title?: string, claim?: string }} f
 * @returns {string}
 */
function findingTitle(f) {
  if (f.title) return f.title;
  const claim = (f.claim ?? '').trim();
  return claim.length > 80 ? `${claim.slice(0, 77)}…` : claim || '(untitled)';
}

/**
 * Render the human-readable Markdown report from a validated report object.
 *
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const kind = /** @type {'review'|'reverify'} */ (report.kind);
  const scope = /** @type {{ type?: string, description?: string, paths?: string[] }} */ (
    report.scope ?? {}
  );
  const summary = /** @type {Record<string, unknown>} */ (report.summary ?? {});
  const findings = /** @type {Array<Record<string, unknown>>} */ (report.findings ?? []);
  const lenses = /** @type {string[]} */ (report.lenses ?? []);
  const verdicts = countByVerdict(report);

  const out = [];
  out.push(`# Code review — ${scope.description ?? report.review_id}`);
  out.push('');
  out.push(`**Review ID:** ${report.review_id}`);
  out.push(`**Kind:** ${kind}`);
  out.push(`**Created:** ${report.created_at}`);
  out.push(`**Scope:** ${scope.type ?? '—'} — ${scope.description ?? '—'}`);
  out.push(`**Lenses:** ${lenses.join(', ')}`);
  out.push(`**Parent report:** ${report.parent_report ?? '—'}`);
  out.push('');

  out.push('## Executive summary');
  out.push('');
  out.push(/** @type {string} */ (summary.headline) || '_(summary pending)_');
  out.push('');

  out.push('### Verdict counts');
  out.push('');
  out.push('| Verdict | Count |');
  out.push('| ------- | ----- |');
  const verdictLabels = {
    confirmed: 'Confirmed',
    downgraded: 'Downgraded',
    false_positive: 'False positive',
    needs_decision: 'Needs decision',
    resolved: 'Resolved',
    still_open: 'Still open',
    partially_fixed: 'Partially fixed',
    regressed: 'Regressed',
  };
  for (const [v, label] of Object.entries(verdictLabels)) {
    if (verdicts[v] > 0) out.push(`| ${label} | ${verdicts[v]} |`);
  }
  out.push('');

  const topActions = /** @type {string[]} */ (summary.top_actions ?? []);
  if (topActions.length > 0) {
    out.push('### Top actions');
    out.push('');
    topActions.forEach((a, i) => out.push(`${i + 1}. ${a}`));
    out.push('');
  }

  const mainVerdicts = MAIN_BODY_VERDICTS[kind] ?? MAIN_BODY_VERDICTS.review;
  const mainFindings = findings.filter(
    (f) => mainVerdicts.has(/** @type {string} */ (f.verdict)) && f.verdict !== 'needs_decision',
  );

  for (const sev of SEVERITY_ORDER) {
    const group = mainFindings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push('---');
    out.push('');
    out.push(`## ${sev[0].toUpperCase()}${sev.slice(1)}`);
    out.push('');
    for (const f of group) out.push(...renderFinding(f));
  }

  const needsDecision = findings.filter((f) => f.verdict === 'needs_decision');
  if (needsDecision.length > 0) {
    out.push('---');
    out.push('');
    out.push('## Needs decision');
    out.push('');
    for (const f of needsDecision) out.push(...renderFinding(f));
  }

  const coverage = /** @type {Record<string, unknown> | undefined} */ (report.coverage);
  if (coverage) {
    out.push('---');
    out.push('');
    out.push('## Coverage ledger');
    out.push('');
    const reviewed = /** @type {string[]} */ (coverage.files_reviewed ?? []);
    const skipped = /** @type {string[]} */ (coverage.files_skipped ?? []);
    out.push(`- **Files reviewed:** ${reviewed.length}`);
    if (skipped.length > 0) out.push(`- **Files skipped:** ${skipped.join(', ')}`);
    const lensesZero = /** @type {Array<{lens:string,reason:string}>} */ (
      coverage.lenses_without_findings ?? []
    );
    for (const e of lensesZero) out.push(`- **${e.lens}** produced no findings — ${e.reason}`);
    out.push('');
  }

  const stats = /** @type {Record<string, number> | undefined} */ (report.stats);
  if (stats && Object.keys(stats).length > 0) {
    out.push('---');
    out.push('');
    out.push('## Pipeline stats');
    out.push('');
    const statLabels = {
      scouts: 'Scouts',
      skeptics_dedicated: 'Dedicated skeptics',
      skeptics_batched: 'Batched skeptics',
      inline_verdicts: 'Inline verdicts',
      grounded_skips: 'Grounded skips',
      carried_forward: 'Carried forward',
      second_opinions: 'Second opinions',
    };
    out.push(
      Object.entries(statLabels)
        .filter(([k]) => stats[k] !== undefined)
        .map(([k, label]) => `**${label}:** ${stats[k]}`)
        .join(' · '),
    );
    out.push('');
  }

  const falsePositives = findings.filter((f) => f.verdict === 'false_positive');
  if (falsePositives.length > 0) {
    out.push('---');
    out.push('');
    out.push('## Appendix A — Rejected findings (false positives)');
    out.push('');
    for (const f of falsePositives) {
      out.push(`### ${f.id}: ${findingTitle(f)}`);
      out.push('');
      out.push(`- **Claim:** ${f.claim}`);
      out.push(`- **Why rejected:** ${f.verdict_reason}`);
      out.push('');
    }
  }

  const dedupe = /** @type {{ items?: Array<{id:string,location:string,claim:string}> }} */ (
    report.dedupe_preflight ?? {}
  );
  if (dedupe.items && dedupe.items.length > 0) {
    out.push('---');
    out.push('');
    out.push('## Appendix B — Dedupe pre-flight');
    out.push('');
    out.push('| ID | Location | Claim |');
    out.push('| -- | -------- | ----- |');
    for (const d of dedupe.items) out.push(`| ${d.id} | ${d.location} | ${d.claim} |`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('## Appendix C — Method');
  out.push('');
  out.push(`- Phase 1: Scout pass (${summary.tentative_count ?? 0} tentative findings)`);
  out.push('- Phase 2: Adversarial skeptic verification (severity-routed, budgeted)');
  if (kind === 'reverify') {
    out.push(`- Re-verification against parent report ${report.parent_report}`);
  }
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Signals pre-flight — map scope → affected workspaces → grounding commands.
// ---------------------------------------------------------------------------

/** Scripts whose output grounds scout findings, in run order. */
export const SIGNAL_SCRIPTS = ['typecheck', 'lint', 'test'];

/**
 * Map scoped paths to the workspaces that own them, so the pre-flight runs
 * typecheck/test on exactly the affected packages instead of the whole repo.
 *
 * @param {string[]} paths Repo-relative paths (any separator).
 * @param {Array<{ name: string, dir: string, scripts?: Record<string, string> }>} packages
 * @returns {{ workspaces: Array<{ name: string, dir: string, scripts?: Record<string, string> }>, unmatched: string[] }}
 */
export function mapPathsToWorkspaces(paths, packages) {
  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  /** @type {Map<string, { name: string, dir: string, scripts?: Record<string, string> }>} */
  const matched = new Map();
  const unmatched = [];

  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const pkg = byDepth.find((k) => p === k.dir || p.startsWith(`${k.dir}/`));
    if (pkg) matched.set(pkg.name, pkg);
    else unmatched.push(p);
  }

  return {
    workspaces: [...matched.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unmatched,
  };
}

/**
 * Suggest the grounding commands to run for a set of matched workspaces — only
 * the scripts each workspace actually defines.
 *
 * @param {Array<{ name: string, scripts?: Record<string, string> }>} workspaces
 * @returns {string[]}
 */
export function suggestSignalCommands(workspaces) {
  const commands = [];
  for (const ws of workspaces) {
    for (const script of SIGNAL_SCRIPTS) {
      if (ws.scripts && ws.scripts[script]) {
        commands.push(`npm run ${script} -w ${ws.name}`);
      }
    }
  }
  return commands;
}

/**
 * @param {Record<string, unknown>} f
 * @returns {string[]}
 */
function renderFinding(f) {
  const lines = [];
  lines.push(`### ${f.id}: ${findingTitle(f)}`);
  lines.push('');
  lines.push(`- **Lens:** ${f.lens}`);
  lines.push(`- **Location:** \`${f.location}\``);
  const sevLine =
    f.verdict === 'downgraded' && f.original_severity
      ? `${f.severity} (was ${f.original_severity})`
      : /** @type {string} */ (f.severity);
  lines.push(`- **Severity:** ${sevLine}`);
  lines.push(`- **Verdict:** ${f.verdict}`);
  lines.push(`- **Claim:** ${f.claim}`);
  lines.push(`- **Reason:** ${f.verdict_reason}`);
  const second = /** @type {{verdict?:string,verdict_reason?:string} | undefined} */ (
    f.second_opinion
  );
  if (second) {
    lines.push(`- **Second skeptic:** ${second.verdict} — ${second.verdict_reason}`);
  }
  lines.push('');
  return lines;
}
