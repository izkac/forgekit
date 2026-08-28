#!/usr/bin/env node
/**
 * Pace from the plan, not from the slug.
 *
 * `pace: auto` classified a free-text signal written at session creation
 * ("Phase 1: VFS + listing engine, headless…") with a keyword regex. Across
 * five real sessions it returned `standard` every time, three of them via
 * "unrecognized scope — failing closed" — a constant dressed as a decision,
 * while `brisk` and `lite` were documented and never selected.
 *
 * By the end of plan the facts exist: how many tasks, how many groups, how
 * many capabilities, whether the spine has wired rows, and whether anything in
 * the change touches money/auth/contracts. This resolves from those.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveChangeDir } from './integrity.mjs';
import { isHighRiskText } from './preferences.mjs';
import { dropScaffoldLines } from './change.mjs';

/** A tasks.md checkbox line. */
const TASK_LINE_RE = /^\s*-\s*\[[ xX]\]\s+/;
/** Numbered task-group heading: `## 1. …` or `## 2) …`. */
const GROUP_RE = /^##\s+\d+[.)]\s+\S/;
/** Fenced code block (opening fence through closing fence, inclusive). */
const FENCE_RE = /^```[\s\S]*?^```/gm;

/**
 * @param {string} file
 * @returns {string}
 */
function readOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Strip markdown fenced code blocks so sample headings/tasks do not count.
 * @param {string} body
 * @returns {string}
 */
function stripFencedBlocks(body) {
  return body.replace(FENCE_RE, '');
}

/**
 * Measure the planned change.
 *
 * @param {{ cwd?: string, session: Record<string, any> }} opts
 * @returns {{ readable: boolean, tasks: number, groups: number, spineRows: number,
 *            spineNotApplicable: boolean, capabilities: number, highRisk: boolean, changeDir: string | null }}
 */
export function collectPlanFacts(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const changeDir = resolveChangeDir({ cwd, session: opts.session });
  const facts = {
    readable: false,
    tasks: 0,
    groups: 0,
    spineRows: 0,
    spineNotApplicable: false,
    capabilities: 0,
    highRisk: false,
    changeDir,
  };
  if (!changeDir || !fs.existsSync(changeDir)) return facts;

  const tasksBody = readOrEmpty(path.join(changeDir, 'tasks.md'));
  const proposalBody = readOrEmpty(path.join(changeDir, 'proposal.md'));
  const designBody = readOrEmpty(path.join(changeDir, 'design.md'));
  facts.readable = Boolean(tasksBody || proposalBody);

  for (const line of stripFencedBlocks(tasksBody).split('\n')) {
    if (TASK_LINE_RE.test(line)) facts.tasks += 1;
    else if (GROUP_RE.test(line)) facts.groups += 1;
  }

  let spineBody = '';
  try {
    const spineFile = path.join(changeDir, 'spine.json');
    if (fs.existsSync(spineFile)) {
      spineBody = fs.readFileSync(spineFile, 'utf8');
      const doc = JSON.parse(spineBody);
      facts.spineRows = Array.isArray(doc.rows) ? doc.rows.length : 0;
      facts.spineNotApplicable = typeof doc.notApplicable === 'string' && doc.notApplicable.trim() !== '';
    }
  } catch {
    /* an unreadable spine contributes nothing but must not throw */
  }

  const capsDir = path.join(changeDir, 'specs');
  try {
    facts.capabilities = fs
      .readdirSync(capsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    facts.capabilities = 0;
  }

  // Risk read across everything the plan says, including the spine — the same
  // fail-closed rule the scorer uses. Two line classes are dropped first:
  // negation lines (see dropNegatedRiskLines): "no money/auth impact" is a
  // disclaimer, not a risk; and verbatim scaffold lines (see
  // dropScaffoldLines): the placeholder "migration notes" the CLI itself
  // wrote into proposal.md is template, not signal (F129).
  facts.highRisk = isHighRiskText(
    [proposalBody, designBody, tasksBody, spineBody, opts.session?.paceSignal, opts.session?.slug]
      .filter(Boolean)
      .map((body) => dropScaffoldLines(dropNegatedRiskLines(String(body))))
      .join(' '),
  );
  return facts;
}

/**
 * At or below this task count a clean change qualifies for the combined close.
 *
 * 5, not 2: cohort 3 measured agents splitting a one-file bugfix into 3–5
 * micro-tasks (red, green, full-suite as separate ticks), so a ≤2 threshold
 * never fired once across eight trials. Task count is granularity, not size —
 * the size signals are capabilities and spine rows, and both still gate.
 */
export const COMBINED_TASKS = 5;

/**
 * Drop lines whose only risk mention is negated ("no persistence migration",
 * "no money/auth surface") before the risk read. Cohort 3 measured the
 * failure: a proposal *disclaiming* risk — in exactly the wording the
 * plan-phase design-skip rule suggests — tripped the keyword regex and forced
 * the full tail on a reconciliation bugfix. A genuinely risky plan names its
 * risk affirmatively somewhere (a task line, the spine, the proposal's What
 * Changes), so dropping negation lines cannot hide it; only lines are
 * dropped, never the whole document.
 */
const NEGATED_RISK_LINE_RE =
  /\b(?:no|not|none|never|without|non|un-?affected|does\s+not|doesn'?t|skips?|skipped|zero)\b[^\n]{0,80}?\b(?:money|payments?|billing|refunds?|auth\w*|oauth|migrat\w*|contracts?|secrets?|credentials?|gdpr|pci)\b/i;

/**
 * @param {string} body
 * @returns {string}
 */
function dropNegatedRiskLines(body) {
  return body
    .split('\n')
    .filter((line) => !NEGATED_RISK_LINE_RE.test(line))
    .join('\n');
}

/**
 * Decide the session tail: `combined` (one closer pass replaces the separate
 * verify + review phases) or `full` (the existing pipeline).
 *
 * Why this exists: measured on the sonnet-hard-v2 cohort, verify + review +
 * done cost 2–4M input tokens per trial against 0.4–0.9M for implement — on a
 * small change the tail is most of the bill, and it re-establishes context
 * three times to check work one diff-read can cover. The floor is one-way:
 * high-risk changes and wired spine rows (a product loop that must be executed,
 * not read) always keep the full tail, whatever the task count.
 *
 * @param {ReturnType<typeof collectPlanFacts>} facts
 * @returns {{ ceremony: 'combined' | 'full', reason: string }}
 */
export function suggestCeremonyFromPlan(facts) {
  if (!facts || !facts.readable) {
    return { ceremony: 'full', reason: 'could not read the plan — failing closed to full' };
  }
  if (facts.highRisk) {
    return { ceremony: 'full', reason: 'high-risk change — full verify and review tail' };
  }
  if (facts.spineRows > 0) {
    return {
      ceremony: 'full',
      reason: `${facts.spineRows} spine row(s) — the product loop is executed at verify, not read`,
    };
  }
  if (facts.tasks <= COMBINED_TASKS && facts.capabilities <= 1) {
    return {
      ceremony: 'combined',
      reason: `${facts.tasks} task(s), single capability, no spine rows — one closer pass covers the tail`,
    };
  }
  return {
    ceremony: 'full',
    reason: `${facts.tasks} tasks, ${facts.capabilities} capability dir(s) — full tail`,
  };
}

/**
 * Decide the plan-time exit ramp: whether Forge offers to leave rather than
 * write a proposal, design, tasks, spine and brief for this change (D2).
 *
 * Reuses `COMBINED_TASKS`, not a third "small" number. D2's own framing is
 * that leaving Forge is "the same evidence plan-facts.mjs already uses to
 * resolve resolvedCeremony: combined ... generalizes it one step further" —
 * so the shape that already earns the cheap tail is exactly the shape that
 * qualifies to skip the tail (and everything before it) entirely. Not
 * `BRISK_TASKS`: that pace threshold excludes `tasks === 0`, which does not
 * translate here — see the zero-tasks note below.
 *
 * `tasks === 0` does not qualify, and reads as its own case rather than
 * falling into the `<= COMBINED_TASKS` branch (group review, fix round).
 * The reasoning above ("a change readable as nothing to do is not evidence
 * against leaving Forge") was written for `collectPlanFacts` reading a real
 * `tasks.md` off disk, where zero is a *measured* fact about an unusually
 * empty plan. `forge exit-check` (4.5) calls this with `tasks` *asserted* by
 * the agent as a bare flag before anything is scaffolded — "0 tasks" there
 * means nothing has been shaped yet, not that a shaped, small change
 * happens to need none. The exit ramp's own precondition is *shaped* work
 * ("After brainstorm... evaluate the shaped work against the plan-time exit
 * conditions"), so a zero-task assertion is outside what this resolver
 * should ever wave through, on either fact source.
 *
 * @param {ReturnType<typeof collectPlanFacts>} facts
 * @returns {{ qualifies: boolean, reason: string }}
 */
export function suggestExitFromPlan(facts) {
  if (!facts || !facts.readable) {
    return { qualifies: false, reason: 'could not read the plan — failing closed, no exit offered' };
  }
  if (facts.highRisk) {
    return { qualifies: false, reason: 'high-risk change — no exit offered, however small' };
  }
  if (facts.spineRows > 0) {
    return {
      qualifies: false,
      reason: `${facts.spineRows} spine row(s) — a wired capability needs a tracked change`,
    };
  }
  if (facts.tasks < 1) {
    return {
      qualifies: false,
      reason: 'zero tasks — nothing shaped yet, not a small change, no exit offered',
    };
  }
  if (facts.tasks <= COMBINED_TASKS && facts.capabilities <= 1) {
    return {
      qualifies: true,
      reason: `${facts.tasks} task(s), single capability, no spine rows — small enough to leave Forge`,
    };
  }
  return {
    qualifies: false,
    reason: `${facts.tasks} tasks, ${facts.capabilities} capability dir(s) — too large to leave Forge`,
  };
}

/** Tasks at or above this count mean a multi-surface change. */
const STANDARD_TASKS = 15;
/** Below this, with nothing else going on, the ceremony is not worth it. */
const BRISK_TASKS = 6;

/**
 * @param {ReturnType<typeof collectPlanFacts>} facts
 * @returns {{ pace: string, reason: string }}
 */
export function suggestPaceFromPlan(facts) {
  if (!facts || !facts.readable) {
    return { pace: 'standard', reason: 'could not read the plan — failing closed to standard' };
  }
  if (facts.highRisk) {
    // Deliberately `standard`, not `thorough`. Risk is a property of a *task*,
    // and the per-task hard floor (`shouldReviewTask`) already dispatches an
    // immediate reviewer for every task that carries it, on every pace. Setting
    // the session to `thorough` on top of that bought nothing for the risky
    // tasks and a full per-task reviewer for every low-risk task sharing the
    // change — one mention of "refund" in a proposal doubled the reviewer count
    // for the docs and config tasks next to it. Measured on the hard-v2 eval
    // arm: whole-plan escalation was the common case, not the exception.
    // `forge prefs thorough` still pins thorough when an operator wants it.
    return {
      pace: 'standard',
      reason:
        'plan touches money/auth/contracts/migrations — session stays standard; only matching task lines get an immediate review',
    };
  }
  if (facts.tasks >= STANDARD_TASKS) {
    return { pace: 'standard', reason: `${facts.tasks} tasks across ${facts.groups} group(s)` };
  }
  if (facts.spineRows >= 2) {
    return {
      pace: 'standard',
      reason: `${facts.spineRows} spine rows — wired capabilities need per-group review`,
    };
  }
  if (facts.tasks > 0 && facts.tasks < BRISK_TASKS && facts.spineRows === 0 && facts.capabilities <= 1) {
    return {
      pace: 'brisk',
      reason: `${facts.tasks} tasks, single capability, no wired spine rows`,
    };
  }
  return {
    pace: 'standard',
    reason: `${facts.tasks} tasks, ${facts.spineRows} spine row(s) — default`,
  };
}
