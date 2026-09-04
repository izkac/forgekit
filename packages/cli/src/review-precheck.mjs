/**
 * Review precheck — the machine-verifiable half of a code review, computed
 * once and pasted into the reviewer packet so no reviewer re-derives it.
 *
 * Measured on the brainstorm-hardening session: reviewers spent most of their
 * requests re-running test suites the verify phase had run, re-running
 * `forge spine|e2e|defer|integrity-check`, and hand-checking tdd-runs.jsonl
 * pairing — all deterministic, all already implemented in `integrity.mjs`. The
 * one real finding across nine sessions (a guard-allowance reason that
 * contradicted the diff) is exactly the kind of fact this block surfaces.
 *
 * Library only — the CLI lives in `review-precheck-cli.mjs` so
 * `review-label-cli.mjs` can import `collectPrecheck` without running it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  completedTddTaskDirs,
  hasNoTddDeclaration,
  hasRedBeforeGreen,
  readTddRunStamps,
  runIntegrityChecks,
} from './integrity.mjs';
import { loadAllowances } from './guard.mjs';
import { NO_TDD_REASON_LABEL } from './record-evidence.mjs';
import { REJECTION_RE, SELF_REVIEW_RE, attributionRegion } from './review-census.mjs';
import { collectPlanFacts } from './plan-facts.mjs';
import { isHighRiskText } from './preferences.mjs';

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionDir
 * @param {boolean} ledgerRequired  session.features.tddEvidence — a task without a ledger or a no-TDD declaration is a gate problem
 * @returns {Array<{ task: string, evidence: 'tdd' | 'no-tdd' | 'test-evidence' | 'missing', ok: boolean, detail: string }>}
 */
function taskFacts(sessionDir, ledgerRequired) {
  const tasksDir = path.join(sessionDir, 'tasks');
  return completedTddTaskDirs(sessionDir).map((task) => {
    const dir = path.join(tasksDir, task);
    const evidenceFile = path.join(dir, 'test-evidence.md');
    const evidenceBody = readOrNull(evidenceFile);
    if (hasNoTddDeclaration(evidenceFile)) {
      const line = (evidenceBody ?? '').split(/\r?\n/).find((l) => l.trim().startsWith(NO_TDD_REASON_LABEL));
      const reason = line ? line.trim().slice(NO_TDD_REASON_LABEL.length).trim() : '';
      return { task, evidence: 'no-tdd', ok: true, detail: `declared no-TDD: ${reason}` };
    }
    const ledger = path.join(dir, 'tdd-runs.jsonl');
    if (fs.existsSync(ledger)) {
      const { stamps, error } = readTddRunStamps(ledger);
      if (error) return { task, evidence: 'tdd', ok: false, detail: `ledger unreadable: ${error}` };
      const paired = hasRedBeforeGreen(stamps);
      const green = stamps.find((s) => s.expect === 'pass' && s.ok);
      const cmd = green ? `${green.cmd} ${green.args.join(' ')}`.trim() : '(no ok green stamp)';
      return {
        task,
        evidence: 'tdd',
        ok: paired,
        detail: paired ? `red→green verified, identical argv: ${cmd}` : `red→green NOT paired (${stamps.length} stamp(s))`,
      };
    }
    if (evidenceBody === null) return { task, evidence: 'missing', ok: false, detail: 'no evidence recorded' };
    if (ledgerRequired) {
      return { task, evidence: 'test-evidence', ok: false, detail: 'tdd-runs.jsonl missing (tddEvidence is on) — the integrity gate refuses this' };
    }
    // Legacy shape: `forge evidence` wrote Command/Exit/Summary. Same field score.mjs reads.
    const exit = /\*\*Exit code:\*\*\s*(\d+)/.exec(evidenceBody);
    const ok = exit ? exit[1] === '0' : false;
    return {
      task,
      evidence: 'test-evidence',
      ok,
      detail: exit ? `legacy test-evidence.md, exit ${exit[1]} (no ledger)` : 'legacy test-evidence.md without an exit code',
    };
  });
}

/**
 * Same walk and classifier as `reviewCensus`, kept per-file because the
 * final reviewer needs to know *which* units an outside reader approved.
 *
 * @param {string} sessionDir
 * @returns {Array<{ unit: string, file: string, attribution: string | null, independent: boolean, rejected: boolean, verdictLines: string[] }>}
 */
function reviewFacts(sessionDir) {
  const tasksDir = path.join(sessionDir, 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const name of ['group-review.md', 'task-review.md']) {
      const file = path.join(tasksDir, e.name, name);
      const body = readOrNull(file);
      if (body === null) continue;
      const lines = body.split(/\r?\n/);
      const attribution = lines.find((l) => /^Reviewer:/i.test(l.trim())) ?? null;
      out.push({
        unit: e.name,
        file: `tasks/${e.name}/${name}`,
        attribution: attribution ? attribution.trim() : null,
        // No attribution at all is nobody's review — the census tolerates it
        // for scoring, the tier rail must not cash it in as an outside reader.
        independent: attribution !== null && !SELF_REVIEW_RE.test(attributionRegion(body)),
        rejected: REJECTION_RE.test(body),
        verdictLines: lines.filter((l) => /\b(APPROVED|REJECTED|NOT READY|READY)\b/.test(l)).slice(0, 3).map((l) => l.trim()),
      });
    }
  }
  return out;
}

/**
 * @param {string} cwd
 * @param {string | undefined} baseCommit
 * @returns {{ tracked: string[], untracked: string[] } | null}
 */
function changedFiles(cwd, baseCommit) {
  if (typeof baseCommit !== 'string' || !baseCommit) return null;
  const diff = spawnSync('git', ['diff', '--name-status', baseCommit], { cwd, encoding: 'utf8' });
  if (diff.status !== 0) return null;
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).forge'],
    { cwd, encoding: 'utf8' },
  );
  return {
    tracked: diff.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\t/g, ' ')),
    untracked: untracked.status === 0 ? untracked.stdout.split('\n').filter(Boolean) : [],
  };
}

/**
 * @param {{ cwd?: string, sessionDir: string, session: Record<string, any>, integrity?: boolean, quick?: boolean }} opts
 *   `quick` — only what the tier rail needs (reviews + risk); no git, no ledgers, no integrity.
 */
export function collectPrecheck(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const { sessionDir, session } = opts;
  const quick = opts.quick === true;
  const integrity =
    quick || opts.integrity === false ? null : runIntegrityChecks({ cwd, sessionDir, session });
  const reviews = reviewFacts(sessionDir);
  // Plan facts read the change dir; a direct session, or one whose change is
  // already archived, has none — fall back to the slug/signal read the pace
  // resolver uses, so a `rotate-webhook-secret` never downgrades its reviewer.
  const highRisk =
    collectPlanFacts({ cwd, session }).highRisk === true ||
    isHighRiskText([session.paceSignal, session.slug].filter(Boolean).join(' '));
  // Integration mode: an outside reader has approved at least one unit, so
  // the final reviewer trusts those hunks and reads the change as a whole.
  // Self-check units (docs-only groups, mid-group tasks under per-group) are
  // expected beside them. Full-diff mode: no dispatched reviewer has read any
  // code (brisk/lite) — the final reviewer is the first outside reader.
  const independent = reviews.filter((r) => r.independent);
  const mode = independent.length > 0 ? 'integration' : 'full-diff';
  const rejected = independent.filter((r) => r.rejected).map((r) => r.unit);
  let allowances = [];
  let allowancesError = null;
  if (!quick) {
    try {
      allowances = loadAllowances(sessionDir);
    } catch (err) {
      allowancesError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    sessionId: session.id,
    baseCommit: session.baseCommit ?? null,
    pace: session.resolvedPace ?? session.pace ?? null,
    ceremony: session.resolvedCeremony ?? null,
    highRisk,
    integrity: integrity ? { ok: integrity.ok, problems: integrity.problems } : null,
    tasks: quick ? [] : taskFacts(sessionDir, session?.features?.tddEvidence === true),
    allowances,
    allowancesError,
    changed: quick ? null : changedFiles(cwd, session.baseCommit),
    reviews,
    finalReview: {
      mode,
      tier: highRisk || mode === 'full-diff' ? 'capable' : 'standard',
      rejected,
    },
  };
}

/**
 * Markdown block for the reviewer packet.
 *
 * @param {ReturnType<typeof collectPrecheck>} p
 */
export function renderPrecheck(p) {
  const lines = ['## Forge precheck (machine-verified — do not re-run these)', ''];
  lines.push(
    `Session ${p.sessionId} · base ${p.baseCommit ?? 'none'} · pace ${p.pace ?? '?'} · ceremony ${p.ceremony ?? '?'}${p.highRisk ? ' · HIGH-RISK' : ''}`,
  );
  if (p.integrity) {
    lines.push(
      p.integrity.ok
        ? 'Integrity (deferrals, guarded files, tdd ledgers, gates, spine, e2e): OK'
        : `Integrity: PROBLEMS\n${p.integrity.problems.map((x) => `- ${x}`).join('\n')}`,
    );
  }
  lines.push('', '### Task evidence');
  if (p.tasks.length === 0) lines.push('- none recorded');
  for (const t of p.tasks) lines.push(`- ${t.task}: ${t.ok ? 'ok' : 'FAIL'} — ${t.detail}`);
  lines.push('', '### Guard allowances (judge the reason, not the fact)');
  if (p.allowancesError) lines.push(`- UNREADABLE guard-allowances.json: ${p.allowancesError}`);
  else if (p.allowances.length === 0) lines.push('- none');
  for (const a of p.allowances) lines.push(`- ${a.path} (${a.phase ?? 'phase ?'}): ${a.reason}`);
  if (p.changed) {
    lines.push('', `### Changed since base (${p.changed.tracked.length} tracked, ${p.changed.untracked.length} untracked)`);
    for (const f of p.changed.tracked) lines.push(`- ${f}`);
    for (const f of p.changed.untracked) lines.push(`- ?? ${f}`);
  }
  lines.push('', '### Reviews already recorded');
  if (p.reviews.length === 0) lines.push('- none — no dispatched reviewer has read this change yet');
  for (const r of p.reviews) {
    lines.push(
      `- ${r.unit} (${r.file}): ${r.independent ? 'independent' : 'self-check'}${r.rejected ? ', carries a REJECTED verdict' : ''} — ${r.attribution ?? 'no Reviewer: line'}`,
    );
    for (const v of r.verdictLines) lines.push(`  - ${v}`);
  }
  lines.push(
    '',
    `Final review mode: **${p.finalReview.mode}** (suggested tier: ${p.finalReview.tier})`,
    p.finalReview.mode === 'integration'
      ? 'Units marked independent were read by an outside reviewer; review the change as a whole — seams between groups, spec-to-runtime trace, product loop. Self-check units and any unit carrying a REJECTED verdict are yours to read in full.'
      : 'No outside reviewer has read the code; read the whole diff.',
  );
  if (p.finalReview.rejected.length > 0) {
    lines.push(`Re-read in full (REJECTED on record): ${p.finalReview.rejected.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}
