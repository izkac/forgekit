#!/usr/bin/env node
/**
 * `forge fleet report` — the cross-project trend, from the durable ledgers.
 *
 * Answering "is Forge getting better here?" previously meant reading session
 * directories by hand, which is both slow and impossible once cleanup has run.
 * Every project already keeps `scorecards.jsonl`, and since 0.3.16 also
 * `sessions.jsonl` and `deferrals.jsonl`; the fleet registry knows where the
 * projects are. This joins them.
 *
 * Library half — `fleet.mjs` owns the `report` subcommand.
 */

import path from 'node:path';
import { readLedger } from './ledger.mjs';

/**
 * @param {Array<{ project: string, projectName: string }>} entries fleet registry rows (deduped by project)
 */
export function buildFleetReport(entries) {
  /** @type {Map<string, string>} */
  const projects = new Map();
  for (const e of entries) {
    if (e?.project) projects.set(path.resolve(e.project), e.projectName ?? path.basename(e.project));
  }

  const out = {
    projects: /** @type {any[]} */ ([]),
    openDeferrals: /** @type {any[]} */ ([]),
    totals: {
      projects: 0,
      sessions: 0,
      meanScore: null,
      grades: /** @type {Record<string, number>} */ ({}),
      capped: 0,
      capReasons: /** @type {string[]} */ ([]),
      topDeductions: /** @type {any[]} */ ([]),
      reviews: {
        independent: 0,
        selfChecks: 0,
        rejections: 0,
        finalIndependent: 0,
        finalSelf: 0,
        /** Census rules seen, sorted. More than one means these totals mix scales. */
        rules: /** @type {number[]} */ ([]),
        mixedRules: false,
        /**
         * How the counted final-review verdicts were reached, sorted. More
         * than one means `finalIndependent` / `finalSelf` add measurements of
         * different kinds. `unknown` is a line written before the grade was
         * recorded — not a grade, and never folded into one.
         */
        evidence: /** @type {string[]} */ ([]),
        mixedEvidence: false,
      },
      subagents: 0,
      openDeferrals: 0,
    },
  };

  /** @type {Map<string, { id: string, lostPoints: number, sessions: number }>} */
  const deductions = new Map();
  let scoreSum = 0;

  for (const [root, projectName] of projects) {
    const forgeDir = path.join(root, '.forge');
    const scores = readLedger(path.join(forgeDir, 'scorecards.jsonl'));
    if (scores.length === 0) continue;

    const digests = readLedger(path.join(forgeDir, 'sessions.jsonl'));
    const byId = new Map(digests.map((d) => [d.sessionId, d]));
    const deferrals = readLedger(path.join(forgeDir, 'deferrals.jsonl'));

    const sessions = scores.map((s) => {
      const digest = byId.get(s.sessionId) ?? null;
      return {
        sessionId: s.sessionId,
        slug: s.slug ?? digest?.slug ?? null,
        score: typeof s.score === 'number' ? s.score : null,
        grade: s.grade ?? null,
        capped: Array.isArray(s.caps) && s.caps.length > 0,
        caps: s.caps ?? [],
        scoredAt: s.scoredAt ?? null,
        reviews: digest?.reviews ?? null,
        subagents: digest?.subagentsDispatched ?? null,
        checkpoints: digest?.checkpoints ?? null,
        health: digest?.health ?? null,
        durationHours: digest?.durationHours ?? null,
      };
    });

    let projectSum = 0;
    let projectScored = 0;
    for (const s of sessions) {
      out.totals.sessions += 1;
      if (typeof s.score === 'number') {
        scoreSum += s.score;
        projectSum += s.score;
        projectScored += 1;
      }
      if (s.grade) out.totals.grades[s.grade] = (out.totals.grades[s.grade] ?? 0) + 1;
      if (s.capped) {
        out.totals.capped += 1;
        out.totals.capReasons.push(...s.caps);
      }
      if (s.reviews) {
        // A line written before the field existed is rule 0, not "no rule".
        const rule = typeof s.reviews.rule === 'number' ? s.reviews.rule : 0;
        if (!out.totals.reviews.rules.includes(rule)) out.totals.reviews.rules.push(rule);
        out.totals.reviews.independent += s.reviews.independent ?? 0;
        out.totals.reviews.selfChecks += s.reviews.selfChecks ?? 0;
        out.totals.reviews.rejections += s.reviews.rejections ?? 0;
        if (s.reviews.final === 'independent') out.totals.reviews.finalIndependent += 1;
        if (s.reviews.final === 'self') out.totals.reviews.finalSelf += 1;
        if (s.reviews.final === 'independent' || s.reviews.final === 'self') {
          // Graded per line, because `rule` cannot do it: rule 4 is *defined*
          // as "host evidence where available, prose otherwise", so a rule-4
          // line carries either kind permanently and no future rule number
          // separates them. Measured across 20 real sessions on this machine:
          // 1 host, 7 inferred, 12 with no final review at all.
          //
          // Only lines that contribute a verdict are graded. A line with no
          // final review adds nothing to the two totals below, so it cannot
          // make them incomparable, and counting it would raise the warning on
          // almost every fleet — a warning that always fires is trained away.
          //
          // A line whose grade is missing, or is not a string, is `unknown`:
          // both mean the grade cannot be named, and neither is allowed to
          // become one. That is the same absence-is-not-a-negative rule this
          // whole subsystem is built on, at the last place the data is read.
          const grade =
            typeof s.reviews.evidence === 'string' && s.reviews.evidence
              ? s.reviews.evidence
              : 'unknown';
          if (!out.totals.reviews.evidence.includes(grade)) {
            out.totals.reviews.evidence.push(grade);
          }
        }
      }
      if (typeof s.subagents === 'number') out.totals.subagents += s.subagents;
    }

    for (const s of scores) {
      for (const d of s.deductions ?? []) {
        const lost = Math.max(0, (d.max ?? 0) - (d.points ?? 0));
        if (lost === 0) continue;
        const acc = deductions.get(d.id) ?? { id: d.id, lostPoints: 0, sessions: 0 };
        acc.lostPoints += lost;
        acc.sessions += 1;
        deductions.set(d.id, acc);
      }
    }

    for (const d of deferrals) {
      out.openDeferrals.push({ projectName, ...d });
    }
    out.totals.openDeferrals += deferrals.length;

    out.projects.push({
      projectName,
      project: root,
      sessions,
      scored: projectScored,
      meanScore: projectScored ? Math.round(projectSum / projectScored) : null,
    });
  }

  out.totals.projects = out.projects.length;
  const scored = out.projects.reduce((n, p) => n + p.scored, 0);
  out.totals.meanScore = scored ? Math.round(scoreSum / scored) : null;
  out.totals.reviews.rules.sort((a, b) => a - b);
  out.totals.reviews.mixedRules = out.totals.reviews.rules.length > 1;
  out.totals.reviews.evidence.sort((a, b) => a.localeCompare(b));
  out.totals.reviews.mixedEvidence = out.totals.reviews.evidence.length > 1;
  out.totals.topDeductions = [...deductions.values()].sort((a, b) => b.lostPoints - a.lostPoints);
  return out;
}

/**
 * @param {ReturnType<typeof buildFleetReport>} report
 */
export function formatFleetReport(report) {
  const t = report.totals;
  if (t.sessions === 0) {
    return 'No scored sessions in any registered project yet. Finish one with `forge phase done`.\n';
  }
  const lines = [];
  const grades = Object.entries(t.grades)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, n]) => `${g}:${n}`)
    .join(' ');
  lines.push(
    `Forge fleet — ${t.sessions} session(s) across ${t.projects} project(s) · mean ${t.meanScore} · ${grades}`,
  );
  if (t.capped) lines.push(`  capped: ${t.capped} session(s) — a cap is a process failure, not a rounding error`);
  lines.push(
    `  reviews: ${t.reviews.independent} dispatched · ${t.reviews.selfChecks} self-check · ${t.reviews.rejections} rejection round(s) · final independent ${t.reviews.finalIndependent} / self ${t.reviews.finalSelf}`,
  );
  if (t.reviews.mixedRules) {
    lines.push(
      `    ⚠ mixed census rules (${t.reviews.rules.join(', ')}) — these review totals sum verdicts produced by different classifiers and are not comparable`,
    );
  }
  if (t.reviews.mixedEvidence) {
    lines.push(
      `    ⚠ mixed authorship evidence (${t.reviews.evidence.join(', ')}) — the final-review verdicts above were measured different ways and are not comparable; "unknown" is a line whose grade could not be read, whether because it predates the field or because it is corrupt`,
    );
  }
  if (t.openDeferrals) lines.push(`  carried debt: ${t.openDeferrals} unresolved deferral(s)`);
  lines.push('');

  for (const p of report.projects) {
    lines.push(`${p.projectName} — ${p.sessions.length} session(s), mean ${p.meanScore ?? '—'}`);
    for (const s of p.sessions.slice(-8)) {
      const marks = [
        s.grade ? `${s.score}/${s.grade}` : '—',
        s.reviews ? `rev ${s.reviews.independent}i/${s.reviews.selfChecks}s` : null,
        s.reviews?.rejections ? `rej ${s.reviews.rejections}` : null,
        s.capped ? 'CAPPED' : null,
      ].filter(Boolean);
      lines.push(`  ${String(s.slug ?? s.sessionId).padEnd(34)} ${marks.join(' · ')}`);
    }
    lines.push('');
  }

  if (t.topDeductions.length) {
    lines.push('Where points go:');
    for (const d of t.topDeductions.slice(0, 5)) {
      lines.push(`  ${d.id.padEnd(18)} −${d.lostPoints} pts across ${d.sessions} session(s)`);
    }
    lines.push('');
  }

  if (report.openDeferrals.length) {
    lines.push('Carried debt (unresolved deferrals):');
    for (const d of report.openDeferrals.slice(0, 10)) {
      lines.push(`  ${d.projectName}/${d.change ?? d.slug ?? '?'} task ${d.task}: ${d.reason}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
