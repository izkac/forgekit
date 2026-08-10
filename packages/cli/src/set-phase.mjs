#!/usr/bin/env node
/**
 * Update Forge session phase and optional fields.
 *
 * Usage:
 *   forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--allow-incomplete "<reason>"]
 *
 * `--openspec <change>` names the change for both engines (openspec/changes/<change>
 * or specs/changes/<change>).
 *
 * `finish` / `done` refuse unless verify-evidence.md exists and all tasks are
 * complete, unless `--allow-incomplete "<reason>"` is provided.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  appendPhaseHistory,
  loadSession,
  readActive,
  resolveSessionOrExit,
  saveSession,
  writeActive,
} from './lib.mjs';
import { isTerminalPhase } from './lib/fleet.mjs';
import { briefProblem, checkBrief } from './brief.mjs';
import { collectPlanFacts, suggestCeremonyFromPlan, suggestPaceFromPlan } from './plan-facts.mjs';
import { isHighRiskText } from './preferences.mjs';
import { reviewCensus } from './review-census.mjs';
import { frozenReviewVerdict } from './review-verdict.mjs';
import { runIntegrityChecks } from './integrity.mjs';
import { writeSessionScorecard } from './score.mjs';
import { bindHost } from './metrics/host.mjs';
import { collectMetrics, writeMetrics } from './metrics/collect.mjs';
import { reviewEvidence } from './metrics/review-evidence.mjs';
import { openFindings } from './findings.mjs';

const VALID_PHASES = new Set([
  'triage',
  'brainstorm',
  'plan',
  'implement',
  'verify',
  'review',
  'finish',
  'done',
  'skipped',
]);

/** Escalate auto-resolved brisk/lite when the plan has at least this many tasks. */
export const TASK_COUNT_ESCALATION_THRESHOLD = 15;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  process.stderr.write(
    'Usage: forge phase <phase> [--plan-type openspec|specs|throwaway|direct] [--openspec <change>] [--tasks-total N] [--tasks-complete N] [--subagents N] [--allow-incomplete "<reason>"] [--final-review-waived "<reason>"] [--reopen-waived "<reason>"] [--session <id>]\n',
  );
  process.exit(1);
}

const phase = args[0];
if (!VALID_PHASES.has(phase)) {
  process.stderr.write(`Invalid phase: ${phase}\n`);
  process.exit(1);
}

let sessionId = null;
let planType = null;
let openspecChange = null;
let tasksTotal = null;
let tasksComplete = null;
let subagentsDispatched = null;
let allowIncomplete = null;
let finalReviewWaived = null;
let reopenWaived = null;

for (let i = 1; i < args.length; i += 1) {
  const flag = args[i];
  const next = args[i + 1];
  if (flag === '--session' && next) {
    sessionId = next;
    i += 1;
  } else if (flag === '--plan-type' && next) {
    planType = next;
    i += 1;
  } else if (flag === '--openspec' && next) {
    openspecChange = next;
    i += 1;
  } else if (flag === '--tasks-total' && next) {
    tasksTotal = Number(next);
    i += 1;
  } else if (flag === '--tasks-complete' && next) {
    tasksComplete = Number(next);
    i += 1;
  } else if (flag === '--subagents' && next) {
    subagentsDispatched = Number(next);
    i += 1;
  } else if (flag === '--final-review-waived' && next) {
    finalReviewWaived = next;
    i += 1;
  } else if (flag === '--reopen-waived' && next) {
    reopenWaived = next;
    i += 1;
  } else if (flag === '--allow-incomplete' && next) {
    allowIncomplete = next;
    i += 1;
  }
}

/**
 * The phases whose damage a re-run does not undo.
 *
 * `done` and `finish` write the scorecard, the `sessions.jsonl` digest and the
 * money/auth verdict: acting on the wrong session scores and files the wrong
 * change, and the right one never reaches the final-review floor at all.
 *
 * `skipped` looks harmless and is not. It is *terminal*, so the session leaves
 * `unfinishedSessions()`' view — nothing warns about it again — and it writes no
 * digest line, because the scorecard is gated on `done|finish`. A later
 * transition on any other session moves the pointer off it, and the next bare
 * `forge cleanup` then removes it: reviews, evidence and all, with no durable
 * record that it ever existed. `/forge:skip`'s own template runs the bare
 * command. Re-running does not undo that; nothing does.
 *
 * Everywhere else a wrong guess costs a re-run, so everywhere else warns.
 */
const GATE_PHASES = new Set(['done', 'finish', 'skipped']);

// One decision point for which session this acts on, and one implementation of
// what ambiguity costs — `resolveSessionOrExit`. An earlier version of this
// file inlined its own copy of that logic, which is how two call sites drift
// into disagreeing about the same rule.
sessionId = resolveSessionOrExit(sessionId, {
  command: `forge phase ${phase}`,
  strict: GATE_PHASES.has(phase),
});

const { dir, session } = loadSession(sessionId);

session.phase = phase;
appendPhaseHistory(session, phase, new Date().toISOString());

// A session created in one host session and resumed in another accumulates
// both ids, so telemetry can find every transcript that drove it. Bound here,
// before the gates and the scorecard: the collector runs at scorecard time, so
// an id first seen on this very command must already be recorded, and pure
// bookkeeping on an in-memory object must not depend on which gates pass.
// Silent on failure by design: running outside a host (Cursor, Codex, a plain
// shell) is normal, and a warning on every command would be trained away.
try {
  bindHost(session, process.env);
} catch {
  // advisory — a missing binding must never block a phase transition
}

if (planType) session.planType = planType;
if (openspecChange !== null) session.openspecChange = openspecChange;
if (tasksTotal !== null) session.tasksTotal = tasksTotal;
if (tasksComplete !== null) session.tasksComplete = tasksComplete;
if (subagentsDispatched !== null) session.subagentsDispatched = subagentsDispatched;

/**
 * Escalate under-scoped auto pace when the plan is large.
 * Only when pace is not user-pinned and current resolved pace is brisk/lite.
 */
function maybeEscalatePaceForTaskCount() {
  const total = Number(session.tasksTotal) || 0;
  if (total < TASK_COUNT_ESCALATION_THRESHOLD) return;
  if (session.pacePinned === true) return;
  const resolved = session.resolvedPace;
  if (resolved !== 'brisk' && resolved !== 'lite') return;
  session.resolvedPace = 'standard';
  session.paceReason = `escalated: ${total} tasks`;
  session.paceEscalated = true;
}

/**
 * Re-resolve `auto` pace from the plan on the way into implement.
 *
 * At `forge new` the only signal is a free-text slug, and classifying that
 * returned `standard` on every real session (three of them via "unrecognized
 * scope — failing closed"). By this point the plan exists: task count, group
 * count, capabilities, spine rows and whether anything touches money/auth are
 * all facts, so decide from those instead.
 */
function maybeResolvePaceFromPlan() {
  if (phase !== 'implement') return;
  if (session.pace !== 'auto' || session.pacePinned === true) return;
  try {
    const facts = collectPlanFacts({ session });
    if (!facts.readable) return;
    const suggested = suggestPaceFromPlan(facts);
    if (suggested.pace === session.resolvedPace) return;
    session.paceResolvedFrom = 'plan';
    session.resolvedPace = suggested.pace;
    session.paceReason = `plan: ${suggested.reason}`;
    process.stderr.write(`[forge] Pace auto → ${suggested.pace} (${suggested.reason})\n`);
  } catch (err) {
    // Never block a phase transition — but say so, because a silent catch
    // here would hide a wiring bug as "pace just didn't change".
    process.stderr.write(
      `[forge] Warning: could not resolve pace from the plan: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

/**
 * Resolve the session tail (`combined` vs `full`) on the way into implement.
 *
 * Independent of pace and of pace pinning: pinning `thorough` is a statement
 * about review cadence, not about running three context-reestablishing tail
 * phases on a two-task change. The high-risk floor is enforced inside the
 * resolver (and re-checked here for the no-plan fallback), so a pinned pace
 * can never *lower* the tail below what risk demands.
 */
function maybeResolveCeremonyFromPlan() {
  if (phase !== 'implement') return;
  try {
    const facts = collectPlanFacts({ session });
    let suggested;
    if (facts.readable) {
      suggested = suggestCeremonyFromPlan(facts);
    } else {
      // No tracked change dir (legacy direct sessions). The same thresholds
      // apply, from what the session itself knows: declared task count and the
      // risk read of its slug/signal.
      const total = Number.isInteger(session.tasksTotal) ? session.tasksTotal : null;
      const risky = isHighRiskText([session.paceSignal, session.slug].filter(Boolean).join(' '));
      if (risky) {
        suggested = { ceremony: 'full', reason: 'high-risk signals — full verify and review tail' };
      } else if (total !== null && total > 0 && total <= 2) {
        suggested = {
          ceremony: 'combined',
          reason: `no readable plan; ${total} declared task(s), no high-risk signals — one closer pass covers the tail`,
        };
      } else {
        suggested = { ceremony: 'full', reason: 'no readable plan — failing closed to full' };
      }
    }
    if (suggested.ceremony === session.resolvedCeremony) return;
    session.resolvedCeremony = suggested.ceremony;
    session.ceremonyReason = suggested.reason;
    process.stderr.write(`[forge] Ceremony → ${suggested.ceremony} (${suggested.reason})\n`);
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not resolve ceremony from the plan: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

maybeResolvePaceFromPlan();
maybeEscalatePaceForTaskCount();
maybeResolveCeremonyFromPlan();

/**
 * Hard gate: implementation may not start until the operator brief exists and
 * matches the current specs — the plan-approval checkpoint is only as strong
 * as the human's comprehension of it. `--allow-incomplete "<reason>"` records
 * an honest skip.
 */
function enforceBriefGate() {
  if (phase !== 'implement') return;
  const result = checkBrief({ session });
  if (result.ok) {
    delete session.briefSkipped;
    return;
  }
  if (allowIncomplete) {
    session.briefSkipped = allowIncomplete;
    return;
  }
  process.stderr.write(
    `Cannot enter phase "implement":\n  - ${briefProblem(result)}\n` +
      'Write the brief (see forge references/operator-brief.md), forge brief stamp, ' +
      'or pass --allow-incomplete "<reason>".\n',
  );
  process.exit(1);
}

enforceBriefGate();

/**
 * Refuse finish/done without verify evidence, full task completion, and a
 * clean integrity check (spine matrix, deferrals, product-loop evidence) —
 * unless --allow-incomplete records an honest reason.
 */
function enforceDoneGate() {
  if (phase !== 'done' && phase !== 'finish') return;

  const total = Number(session.tasksTotal) || 0;
  const complete = Number(session.tasksComplete) || 0;
  const evidencePath = path.join(dir, 'verify-evidence.md');
  const hasEvidence = fs.existsSync(evidencePath);
  const tasksDone = total === 0 || complete === total;

  const problems = [];
  if (!hasEvidence) problems.push('missing verify-evidence.md');
  if (!tasksDone) problems.push(`tasks incomplete (${complete}/${total})`);

  const integrity = runIntegrityChecks({ sessionDir: dir, session });
  problems.push(...integrity.problems);

  if (problems.length === 0) {
    delete session.incompleteReason;
    return;
  }

  if (allowIncomplete) {
    session.incompleteReason = allowIncomplete;
    return;
  }

  process.stderr.write(
    `Cannot enter phase "${phase}":\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
      `Fix the above (forge integrity-check to re-run), or pass --allow-incomplete "<reason>".\n`,
  );
  process.exit(1);
}

/**
 * Hard floor: a high-risk change gets an independent final review.
 *
 * This was a paragraph in the skill and a line in three analysis reports, and
 * it was skipped anyway — the session that most needed it recorded "subagent
 * dispatch was declined twice" in review prose that no gate could see, then
 * scored 100/100. A rule that matters has to be a gate; the waiver is a field
 * so it survives session cleanup and lands in the ledgers.
 */
function enforceFinalReviewFloor() {
  if (phase !== 'done' && phase !== 'finish') return;
  if (finalReviewWaived) {
    session.finalReviewWaived = finalReviewWaived;
    return;
  }
  if (allowIncomplete) return; // already an explicit, recorded escape

  let facts;
  try {
    facts = collectPlanFacts({ session });
  } catch {
    return; // cannot judge risk — do not invent a refusal
  }
  if (!facts.highRisk) {
    delete session.finalReviewWaived;
    return;
  }
  // The frozen verdict, measured moments ago by `freezeReviewVerdict` below —
  // which runs *before* this gate, and must keep doing so. A live census here
  // would read the review file's prose, the text this whole change exists to
  // stop trusting.
  //
  // NO VERDICT MEANS THE MEASUREMENT FAILED, AND THAT IS NOT A REFUSAL.
  // `freezeReviewVerdict` runs on exactly the phases this gate acts on, and it
  // leaves the verdict absent only when `reviewCensus` raised — in which case
  // it has already warned. A live-census fallback here (which `score.mjs` and
  // `ledger.mjs` do keep, because they run for sessions that never reached a
  // freeze) would therefore be reached only in the state where it is certain to
  // raise the same error again: it shipped that way for one round and turned an
  // advisory warning into an uncaught stack trace and a lost transition. Same
  // rule as `collectPlanFacts` above — cannot judge, do not invent a refusal.
  const verdict = frozenReviewVerdict(session);
  if (!verdict) {
    // Failing open is the right direction — see above — but it must not be
    // silent. Only a high-risk change reaches this line, so what just happened
    // is that the money/auth floor did not run, and the session may well end up
    // with no scorecard and no `sessions.jsonl` line either, since the failure
    // that costs the verdict costs those too. The two warnings already on
    // stderr are telemetry-shaped and neither says a gate was skipped; without
    // this, a high-risk session passes unjudged with nothing recorded anywhere.
    process.stderr.write(
      '[forge] Warning: the money/auth final-review floor could not be evaluated — ' +
        'no review verdict was measured, so this high-risk change was not judged.\n',
    );
    return;
  }
  if (verdict.final === 'independent') {
    delete session.finalReviewWaived;
    return;
  }

  process.stderr.write(
    `Cannot enter phase "${phase}": this change touches money/auth/contracts/migrations, ` +
      'and its final review is missing or self-authored.\n' +
      '  - Dispatch an independent final reviewer (forge resolve-model --tier capable), then save reviews/final-review.md\n' +
      '  - Or record the refusal: --final-review-waived "<reason>" (kept on the session and in .forge/sessions.jsonl)\n',
  );
  process.exit(1);
}

/**
 * A finding that has returned twice for this change needs an explicit operator
 * decision before the session can be marked complete.
 */
function enforceReopenFloor() {
  if (phase !== 'done' && phase !== 'finish') return;
  if (reopenWaived) {
    session.reopenWaived = reopenWaived;
    return;
  }

  const changeSlugs = new Set(
    [session.openspecChange, session.slug].filter((slug) => typeof slug === 'string' && slug !== ''),
  );
  const blocking = openFindings(path.join(process.cwd(), '.forge')).filter(
    (finding) => finding.reopenCount >= 2 && changeSlugs.has(finding.change),
  );
  if (blocking.length === 0) {
    delete session.reopenWaived;
    return;
  }

  process.stderr.write(
    `Cannot enter phase "${phase}": findings reopened twice remain open for this change:\n` +
      `${blocking.map((finding) => `  - ${finding.id}`).join('\n')}\n` +
      'Resolve the findings, or record the decision: --reopen-waived "<reason>".\n',
  );
  process.exit(1);
}

/**
 * Measure who wrote the final review, once, and freeze the answer.
 *
 * BEFORE THE GATE, NOT MERELY BEFORE THE SCORECARD. `enforceFinalReviewFloor`
 * below is the money/auth floor and it reads this verdict; the scorecard is
 * another twenty lines down. An earlier draft of this task said "before the
 * scorecard", which is where the metrics block sits and is too late — the same
 * ordering mistake that shipped once already, when `bindHost` ran after the
 * scorecard and a session whose first Forge command was `phase done` recorded
 * `available: false` for good.
 *
 * FROZEN BECAUSE THE EVIDENCE DOES NOT LAST. A one-day-old session on this
 * machine already has no surviving host transcript, so a consumer that
 * remeasured later would get a different answer, or none. Writing it down once
 * is what keeps the gate, the cap and the digest on one reading.
 *
 * FREEZING IS NOT WHAT MAKES THE ATTRIBUTION CORRECT. It never was: three
 * independent review rounds each defeated a version that inferred attribution
 * from something adjacent to the dispatch — a `[createdAt, now]` window a later
 * session's reviewer still landed inside, a sibling search that `forge cleanup`
 * blinded, a ledger index that predated its own field. Each one froze a
 * neighbour's reviewer as `{independent, host}` onto a session whose own final
 * review was a self-check, and passed it through this gate.
 *
 * What makes it correct is that the dispatch description now carries the Forge
 * session id, so a record names the session that made it and crediting one is
 * an equality test. Freezing does what it always did and no more: it keeps the
 * verdict after the host prunes the transcript that proved it.
 *
 * NOT A CLAIM THAT THE MEASUREMENT IS COMPLETE. `reviewEvidence` answers from
 * whatever bound host sessions it can read, and a session bound to two whose
 * older transcript has since been pruned from disk still answers confidently
 * from the surviving newer one (an *unreadable* second binding is a different
 * case, F27, owned by `host.mjs`, and is refused rather than answered). F12's
 * dispatch stamp is what closes that gap, one layer up in `review-census.mjs`,
 * and it does it two ways, not one: where `reviewEvidence` cannot answer at
 * all — unavailable, or available with no well-formed `final` bucket — the
 * stamp DECIDES, grading `recorded`; where it answers `available: true` from
 * that same partial binding and the `final` unit is simply missing (D4:
 * `reviewEvidence`'s `partial` flag, `hostFinalReview`'s `fromAbsence`), the
 * stamp OVERRIDES that absence-negative instead of leaving a reviewer who ran
 * in the pruned half invisible. Neither path touches a measured stop or a
 * complete binding's own absence-negative — both stay `host`, and outrank a
 * stamp. A well-formed bucket below the request floor is a third thing again,
 * never a `host` answer at all: `hostFinalReview` returns `null` there (D3's
 * whole point is "the host looked and cannot say"), so the verdict routes to
 * the review file's prose, graded `inferred` — exactly as
 * `metrics/review-evidence.mjs` states the same rule beside `maxRequests`. The
 * freeze below still matters on the paths the stamp does reach — it is what
 * keeps a `host`-graded verdict from being displaced by a stamp on a later
 * pass.
 *
 * `next` ALSO CARRIES `unitOnRecord` — whether *this* pass saw the deciding
 * (`final`) unit in the host's dispatch record, the same fact the keep rule
 * below computes as `sawTheUnit`. It is frozen here (F49/F52) so a later pass
 * asks the verdict what the earlier pass saw, instead of inferring it from its
 * own evidence grade — the inference that let a pruned dispatch record read
 * identically to one that never existed. The keep rule below reads it.
 *
 * Advisory, exactly like the metrics block below: telemetry may cost a session
 * its measurement, never its transition.
 */
function freezeReviewVerdict() {
  if (phase !== 'done' && phase !== 'finish') return;
  try {
    const evidence = reviewEvidence({ session, env: process.env });
    const census = reviewCensus(dir, { evidence });
    // Whether *this pass* saw the deciding (`final`) unit in the host's
    // dispatch record — computed once here and written onto `next` below as
    // `unitOnRecord`, so the fact persisted on the verdict and the fact the
    // keep rule below reasons about can never drift apart. The keep rule reads
    // it back off the *frozen* verdict on the next pass, as `unitOnRecord`;
    // this binding is that same fact for *this* pass. See the block above it.
    const sawTheUnit =
      evidence.available && !!evidence.units && Object.hasOwn(evidence.units, 'final');
    const next = {
      final: census.finalReview,
      evidence: census.finalReviewEvidence,
      stoppedByOperator: census.stoppedByOperator,
      unitOnRecord: sawTheUnit,
    };
    // A MEASURED `independent` IS NEVER REPLACED BY A GUESS — and nothing else
    // is protected. `finish` then `done` a day apart is ordinary, and the host
    // prunes transcripts in days, so the second pass routinely cannot see what
    // the first one measured; without this, an independent reviewer measured at
    // `finish` would silently degrade to whatever the review file's prose says.
    // That is the spec's "verdict outlives its evidence", and its GIVEN names
    // this exact case.
    //
    // THE RULE IS ASYMMETRIC BECAUSE THE TWO VERDICTS ARE NOT SYMMETRIC IN
    // CONSEQUENCE. A first version kept any `host` verdict, and a stale `self`
    // then refused work: freeze `self` at `finish` when no reviewer had run
    // yet, dispatch a real one, let the host prune overnight, and `done` exits
    // 1 with a remedy the operator has already followed — a regression against
    // 0.3.28 on the very scenario titled "absence of evidence never refuses
    // work", plus a permanent `self`/`host` line in the durable ledger for a
    // session that was independently reviewed. Losing a measurement costs a
    // grade; keeping a stale one costs the work. `review-census.mjs` states the
    // governing rule — fall back to prose, the side that cannot refuse correct
    // work — and this is the one place that could invert it.
    //
    // Everything else refreshes, so a review written between the two passes
    // still counts and a stale `none` or `self` can never strand a session.
    // Same shape as `writeMetrics`' `kept` below, narrower on purpose.
    const frozen = frozenReviewVerdict(session);
    // Widened after the final review (I1). The test used to be `next.evidence
    // !== 'host'`, which let a *host-graded* second reading overwrite the
    // measurement — and the reading that does that needs no adversary: an
    // emptied `subagents/` directory scans clean, yields `seen === 0`, and
    // `seen === 0` is graded `host` ("nothing was dispatched"), so a session
    // that froze `independent` at `finish` was re-graded `self` at `done` and
    // refused. Permanently: `saveSession` runs last, so the refused pass never
    // records the new verdict and every retry repeats it, with
    // `--final-review-waived` the only escape — for a reviewer that really ran.
    //
    // The axis is whether this pass saw **the unit that decides**, not how much
    // it saw. Two host-graded second readings look identical in
    // `{final, evidence}` and must be treated oppositely:
    //
    //   the record CHANGED   a `final` dispatch is still on record and now
    //                        carries `stoppedByUser`. The operator's refusal is
    //                        new information about the thing being judged, so
    //                        refresh — keeping the stale verdict would reopen
    //                        the 0.3.26 escape and pass a session whose
    //                        reviewer was declined.
    //   the record is GONE   no `final` unit in this reading. Whatever else is
    //                        or is not there, nothing was learnt about the
    //                        final review, so keep the measurement.
    //
    // An earlier fix keyed on `seen === 0` instead. That is *narrower* than the
    // rule it replaced, not wider, and an independent review found three ways
    // it stranded a session permanently: a pruned `final` record beside a
    // surviving unlabelled dispatch (`seen > 0`, prose fallback), a partial
    // binding whose older transcript expired between the two passes, and a
    // surviving `forge-review group-01` label — which refused even when the
    // review file read independent. All three are `seen > 0` with no `final`.
    //
    // A frozen `self` or `none` still refreshes freely, which is what the
    // asymmetry was for — a stale negative can never strand a session.
    //
    // READS THE RECORDED FACT, NOT A PROXY FOR IT. `unitOnRecord` is
    // `sawTheUnit` from the pass that froze `frozen`, persisted rather than
    // recomputed: in a single pass the two readings are byte-identical
    // (`evidence === 'host'` and "the deciding unit was on record" agree
    // whenever both are knowable), so nothing here could tell them apart until
    // a *second* pass compares what it now sees against what an earlier pass
    // saw. `frozen.unitOnRecord` is exactly that carried-forward fact.
    // `frozen.evidence === 'host'` after the `??` is not a second policy —
    // `final === 'independent'` on `host` grade is only reachable from a
    // present bucket, so a host-graded independent verdict always had the
    // unit on record, and the new field subsumes the old test rather than
    // contradicting it. Absent (`undefined`) takes that old test because it
    // means "frozen before this field existed" — never "no unit was on
    // record" — and every verdict frozen before this change must keep
    // exactly the behaviour it had.
    //
    // DO NOT REORDER THE CONJUNCTS. `frozen` may be `null`, and only the first
    // test guards it: `null?.final === 'independent'` is `false`, so the two
    // unguarded reads after `&&` are never reached. Move them ahead of it and
    // they raise — into `freezeReviewVerdict`'s `try`, which keeps the
    // transition but silently loses the freeze on a high-risk path and leaves
    // the gate to take its fail-open warning branch.
    const measured =
      frozen?.final === 'independent' && (frozen.unitOnRecord ?? frozen.evidence === 'host');
    const remeasured = next.final === 'independent' && next.evidence === 'host';
    if (measured && !remeasured && !sawTheUnit) {
      process.stderr.write(
        '[forge] Kept the review verdict already measured for this session — this pass had no host evidence to read.\n',
      );
      return;
    }
    session.reviewVerdict = next;
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not measure review authorship: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

freezeReviewVerdict();
enforceFinalReviewFloor();
enforceReopenFloor();
enforceDoneGate();

// Host telemetry on finish/done, and it has to happen *here* — before the
// scorecard, which is what appends the sessions.jsonl digest, and the digest
// reads metrics.json. Collected after it, every session's durable line would
// carry the previous run's numbers, or none at all.
//
// `collectMetrics` already degrades instead of throwing; this guard is for the
// write, and for the same reason as the scorecard's: telemetry may cost a
// session its numbers, never its transition.
if (phase === 'done' || phase === 'finish') {
  try {
    const doc = collectMetrics({ session, sessionDir: dir, env: process.env });
    // A `finish` then `done` pair collects twice. If the host pruned the
    // transcript in between, the second pass must not trade the first pass's
    // real numbers for `available: false`.
    const { kept, error } = writeMetrics({ sessionDir: dir, doc });
    if (error) throw new Error(error);
    if (kept) {
      process.stderr.write(
        '[forge] Kept the metrics already collected for this session — this pass found nothing to measure.\n',
      );
    }
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not collect session metrics: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// L2 scorecard on finish/done — always write so sessions leave a measurable trail
if (phase === 'done' || phase === 'finish') {
  try {
    const { card, mdPath } = writeSessionScorecard({ sessionDir: dir, session });
    session.score = card.score;
    session.scoreGrade = card.grade;
    process.stderr.write(
      `[forge] Session score: ${card.score}/${card.maxScore} grade ${card.grade} → ${mdPath}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[forge] Warning: could not write scorecard: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// LAST, AND THAT IS LOAD-BEARING. Every gate above refuses with `process.exit`,
// so a refused pass writes nothing at all — not the phase, and not the review
// verdict measured moments before it. That is what keeps a wrong positive from
// becoming permanent: `reviewEvidence` can still answer confidently from a
// partial binding — a session bound to two host sessions whose older
// transcript has been pruned answers `available: true` from the surviving
// newer one alone (an *unreadable* binding is F27, owned by `host.mjs`, and is
// refused rather than answered). A `final` unit simply missing from that
// partial answer is where F12's dispatch stamp now gets a second read, one
// layer up in `review-census.mjs` (D4): a valid stamp overrides that
// absence-negative and grades `recorded`, so only a genuinely unstamped
// partial binding can still land on `self` — and if it does, the session is
// refused and the verdict is discarded unwritten, so the next pass measures
// again instead of inheriting the mistake. Moving this above the gates would
// pin it.
// THE POINTER FOLLOWS THE WORK — but only once the transition has been allowed,
// and never for work that is over.
//
// `active.json` was written by `forge new` alone, so "active" meant *most
// recently created*. Placed below every gate because a *refused* transition
// must not move it: the phase never changed, so claiming that session is now
// the one being driven is a lie the next command and the SessionStart hook both
// repeat. Terminal phases are excluded because making a finished session active
// points `forge status`, the resume hook and `forge review-label` at work that
// is done, and hides a session with tasks still in flight.
if (!isTerminalPhase(phase) && readActive()?.sessionId !== sessionId) {
  try {
    writeActive(sessionId);
  } catch (err) {
    // NOT SILENT. The pointer used to be "a convenience"; it stopped being one
    // when commands began resolving through it. A failed write leaves the next
    // command pointing somewhere else, so the transition still succeeds and the
    // operator is told.
    process.stderr.write(
      `[forge] Warning: could not mark ${sessionId} as the active session ` +
        `(${err instanceof Error ? err.message : err}). Pass --session to later commands.\n`,
    );
  }
}

saveSession(dir, session);
process.stdout.write(JSON.stringify({ sessionId, phase: session.phase, session }, null, 2));
process.stdout.write('\n');
