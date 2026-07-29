#!/usr/bin/env node
/**
 * Product loop for the recorded-harness contract — the executable steps behind
 * specs/changes/harness-setup-probe/e2e.json.
 *
 * Drives the SHIPPED binary (packages/cli/bin/forge.mjs) against a scratch
 * project in a temp dir, because the thing under test is what an operator's
 * `forge` does on their checkout, not what a module exports. Unit tests in
 * packages/cli/src/e2e-cli.test.mjs cover the same behaviour one layer down.
 *
 * Phases (each is one e2e.json step; state persists in a fixed temp dir):
 *   all          run every phase in order — this rig's own recorded `probe`
 *   boot         scratch project + session fixture
 *   record       forge e2e harness --set … --setup … --probe …  → read config back
 *   show         forge e2e harness / forge e2e init surface both fields
 *   red-run      a failing loop names the recorded setup
 *   quiet-cases  green-with-setup and red-without-setup print no hint
 *
 * Session-telemetry loop (specs/changes/session-telemetry/e2e.json), sharing
 * `boot` and layering its own fixture on top:
 *   telemetry-collect  synthetic host transcript + sidecar + dispatch ledger →
 *                      forge metrics collect
 *   telemetry-analyze  forge phase done → digest → forge analyze --json
 *
 * Review-authorship-evidence loop (specs/changes/review-authorship-evidence/
 * e2e.json), also layering on `boot`:
 *   review-evidence-decides   a review file that says "self-check" beside a host
 *                             record of a real reviewer → independent, on host
 *                             evidence, past the money/auth done gate
 *   review-evidence-survives  delete the transcript; the recorded verdict does
 *                             not move
 *
 * `all` deliberately stays the harness-setup-probe rig's own five phases: it is
 * that change's recorded probe and its verdict must keep meaning what it meant.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORGE_BIN = path.join(REPO, 'packages', 'cli', 'bin', 'forge.mjs');
// Fixed path (phases are separate processes and must share state), but keyed to
// this checkout so two clones can run the loop at the same time.
const SCRATCH = path.join(
  os.tmpdir(),
  `forgekit-e2e-harness-${createHash('sha256').update(REPO).digest('hex').slice(0, 10)}`,
);

const SETUP_CMD = 'npx playwright install chromium';
const PROBE_CMD = 'npm run test:e2e';
const START_CMD = 'npm run build && npm run preview';
const HINT = 'Harness setup recorded';

/**
 * Run the real forge binary in `cwd`; never throws on a non-zero exit.
 *
 * The operator's own host session id is dropped: this rig drives a throwaway
 * project, and a session bound to the id of the Claude Code session that
 * happens to be running the suite would be measuring the wrong thing.
 *
 * `stdout` is returned separately from the combined `out` because `--json`
 * output has to be parsed, and forge writes advisory notes to stderr.
 */
function forge(cwd, args, extraEnv = {}) {
  const env = { ...process.env, FORGEKIT_FLEET_DIR: path.join(SCRATCH, '.fleet'), ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [FORGE_BIN, ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', code: r.status };
}

/**
 * A throwaway project with an active session tracking a specs change — the
 * minimum shape `forge e2e` needs to resolve a change dir.
 */
function makeProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ id: 's1', slug: 'scratch', planType: 'specs', openspecChange: 'my-change' })}\n`,
  );
  fs.writeFileSync(path.join(dir, '.forge', 'active.json'), `${JSON.stringify({ sessionId: 's1' })}\n`);
  fs.writeFileSync(
    path.join(dir, '.forge', 'config.json'),
    `${JSON.stringify({ plan: { engine: 'specs', dir: 'specs' } }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'specs', 'changes', 'my-change'), { recursive: true });
  return dir;
}

/**
 * A one-step loop for the fixture change. `ok: false` fails the way a missing
 * probe runtime does — the tool's own diagnostic on stderr and a non-zero exit,
 * which is exactly what forge cannot distinguish from a code regression.
 */
function writeLoop(dir, ok) {
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(
    probe,
    ok
      ? 'process.exit(0);\n'
      : "console.error(\"Error: browser executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome\");\nprocess.exit(1);\n",
  );
  fs.writeFileSync(
    path.join(dir, 'specs', 'changes', 'my-change', 'e2e.json'),
    `${JSON.stringify({
      steps: [{ name: 'smoke', cmd: `node ${JSON.stringify(probe.replace(/\\/g, '/'))}` }],
    })}\n`,
  );
}

/** Last `n` lines — the runner reports only a 30-line tail, and a long context
 *  silently pushes the assertion message out of it. */
function tail(text, n) {
  return String(text ?? '').split('\n').slice(-n).join('\n');
}

function fail(message, context) {
  process.stderr.write(`ASSERTION FAILED: ${message}\n${context ?? ''}\n`);
  process.exit(1);
}

/* ---------- session telemetry fixture ---------- */

const HOST_ID = 'e2e0host-0000-1111-2222-333344445555';
const HOST_CFG = path.join(SCRATCH, '.claude-host');
/** 10 coordinator requests + 2 subagent requests. The step's expected total. */
const PARENT_REQUESTS = 10;
const SIDECAR_REQUESTS = 2;

/**
 * One assistant transcript line.
 *
 * The host writes one line per content block and repeats the whole `usage`
 * object on each, so the fixture below spreads 12 requests over 24 lines: a
 * reader that counted lines, or summed usage across them, gets a plausible and
 * completely wrong answer. That is the regression this loop exists to catch.
 */
function assistantLine(requestId, block, at, sidechain) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp: at,
    version: '2.1.220',
    isSidechain: sidechain,
    ...(sidechain ? { agentId: 'a1' } : {}),
    message: {
      id: `msg_${requestId}`,
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: `toolu_${requestId}_${block}`, name: 'Bash' }],
      usage: {
        input_tokens: 3,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 7,
      },
    },
  });
}

/** A synthetic host transcript plus one subagent sidecar, under HOST_CFG. */
function plantTranscripts(at) {
  const projectDir = path.join(HOST_CFG, 'projects', '-scratch-project');
  const sidecarDir = path.join(projectDir, HOST_ID, 'subagents');
  fs.rmSync(HOST_CFG, { recursive: true, force: true });
  fs.mkdirSync(sidecarDir, { recursive: true });

  const parent = [];
  for (let i = 0; i < PARENT_REQUESTS; i += 1) {
    for (let block = 0; block <= i % 3; block += 1) {
      parent.push(assistantLine(`req_p${i}`, block, at, false));
    }
  }
  parent.push(
    JSON.stringify({
      type: 'user',
      timestamp: at,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_req_p0_0', is_error: true }] },
    }),
  );
  fs.writeFileSync(path.join(projectDir, `${HOST_ID}.jsonl`), `${parent.join('\n')}\n`, 'utf8');

  const sidecar = [];
  for (let i = 0; i < SIDECAR_REQUESTS; i += 1) {
    for (let block = 0; block < 2; block += 1) {
      sidecar.push(assistantLine(`req_s${i}`, block, at, true));
    }
  }
  fs.writeFileSync(path.join(sidecarDir, 'agent-a1.jsonl'), `${sidecar.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-a1.meta.json'),
    `${JSON.stringify({
      agentType: 'general-purpose',
      description: 'PRIVATE-E2E-DESCRIPTION',
      toolUseId: 'toolu_dispatch_1',
      spawnDepth: 1,
      model: 'opus',
    })}\n`,
    'utf8',
  );
}

/* ---------- review-authorship-evidence fixture ---------- */

const REVIEW_HOST_ID = 'e2e0revw-0000-1111-2222-666677778888';
/** Kept apart from HOST_CFG so the two loops cannot borrow each other's record. */
const REVIEW_HOST_CFG = path.join(SCRATCH, '.claude-review-host');
const REVIEW_PROJECT_DIR = '-scratch-review-project';
/** A host config dir with no transcripts at all, for the prose-only control. */
const EMPTY_HOST_CFG = path.join(SCRATCH, '.claude-empty-host');
/** The project the control runs in: same review file, no host record. */
const PROSE_PROJECT = `${SCRATCH}-prose`;
/**
 * Exactly what a final-review dispatch is prescribed to be described as.
 *
 * The trailing session id is what makes the record attributable: without it the
 * join is "a review dispatch somewhere in this host conversation", and one
 * Claude Code conversation routinely hosts several Forge sessions. `s1` is the
 * session `makeProject` creates.
 */
const FINAL_REVIEW_DISPATCH = 'forge-review final s1';

/**
 * The whole point of this loop, in one string.
 *
 * It must read as a SELF-CHECK to the prose rule — that is what makes the host
 * record outranking it mean anything. `review-evidence-decides` proves that by
 * running the identical bytes through a project with no host record and
 * requiring `self`; if this text ever drifts to something the prose rule would
 * also call `independent`, the control goes red and says so, rather than the
 * loop passing for the wrong reason.
 *
 * The heading is the phrasing Forge's own skill prescribes for a self-written
 * review, and the body says in plain English that no reviewer was dispatched.
 */
const SELF_CHECK_REVIEW = `# Final review

**Reviewer:** coordinator — self-check

No reviewer subagent was dispatched for this change; I read back my own diff
and convinced myself it was fine. Everything below is my own assessment of my
own work.

## Verdict

APPROVED.
`;

/** A change the money/auth floor applies to, so the done gate actually runs. */
const HIGH_RISK_PROPOSAL = `# Proposal — scratch fixture

Adds a payment authorization step to the checkout flow. This change therefore
touches money and auth, which is what puts it behind the hard floor in
\`forge phase done\`.
`;

/**
 * Layer the review fixture onto an existing scratch project — a high-risk
 * change, a finishable session and a self-check final review.
 *
 * Layered rather than built, so `boot` stays the loop's first step and means
 * something, exactly as `telemetry-collect` layers on it.
 *
 * `hostId` is the only difference between the two projects this phase builds:
 * with it, the host has a dispatch record to answer from; without it, nothing
 * but the prose can decide. Everything else — the review file above all — is
 * written from the same constants in both.
 *
 * @param {string} dir
 * @param {{ createdAt: string, hostId?: string }} options
 */
function layerReviewFixture(dir, options) {
  const changeDir = path.join(dir, 'specs', 'changes', 'my-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), HIGH_RISK_PROPOSAL, 'utf8');
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## Group 1\n\n- [x] 1.1 wire it\n', 'utf8');
  // notApplicable, so the integrity gate does not also demand an executed e2e
  // loop *inside* the fixture project — this loop is the one being executed.
  fs.writeFileSync(
    path.join(changeDir, 'spine.json'),
    `${JSON.stringify(
      { change: 'my-change', notApplicable: 'scratch fixture — nothing is wired', rows: [] },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const sessionDir = path.join(dir, '.forge', 'sessions', 's1');
  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'reviews', 'final-review.md'), SELF_CHECK_REVIEW, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'verify-evidence.md'), '# Verify\n\nAll checks green.\n', 'utf8');

  const sessionFile = path.join(sessionDir, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.createdAt = options.createdAt;
  session.updatedAt = options.createdAt;
  session.phase = 'implement';
  session.tasksTotal = 1;
  session.tasksComplete = 1;
  session.phaseHistory = [{ phase: 'implement', at: options.createdAt }];
  if (options.hostId) {
    session.host = { agent: 'claude-code', sessionIds: [options.hostId], boundAt: options.createdAt };
  } else {
    delete session.host;
  }
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  return { dir, sessionDir, changeDir };
}

/**
 * A host record of one final-review subagent that genuinely ran: the sidecar
 * meta describing it as `forge-review final <session-id>` — the session id is
 * what attributes the record, so no transcript timestamp has to place it.
 *
 * The main transcript beside it is not decoration — `findTranscripts` locates a
 * sidecar directory by finding `<hostId>.jsonl` first, so without it there is
 * no dispatch record to read at all.
 *
 * @param {string} at ISO timestamp inside `[session.createdAt, now]`
 */
function plantReviewerDispatch(at) {
  const projectDir = path.join(REVIEW_HOST_CFG, 'projects', REVIEW_PROJECT_DIR);
  const sidecarDir = path.join(projectDir, REVIEW_HOST_ID, 'subagents');
  fs.rmSync(REVIEW_HOST_CFG, { recursive: true, force: true });
  fs.mkdirSync(sidecarDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, `${REVIEW_HOST_ID}.jsonl`),
    `${assistantLine('req_coord0', 0, at, false)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-rv1.jsonl'),
    `${[assistantLine('req_rv0', 0, at, true), assistantLine('req_rv1', 0, at, true)].join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-rv1.meta.json'),
    `${JSON.stringify({
      agentType: 'general-purpose',
      description: FINAL_REVIEW_DISPATCH,
      toolUseId: 'toolu_dispatch_review',
      spawnDepth: 1,
      model: 'opus',
    })}\n`,
    'utf8',
  );
}

/** An empty host config dir — "no record", as distinct from "a record of none". */
function plantNoHostRecord() {
  fs.rmSync(EMPTY_HOST_CFG, { recursive: true, force: true });
  fs.mkdirSync(path.join(EMPTY_HOST_CFG, 'projects'), { recursive: true });
}

/**
 * The last `.forge/sessions.jsonl` line, parsed — the durable record that
 * outlives both the session directory and the host transcript.
 *
 * @param {string} file
 * @returns {Record<string, any> | null}
 */
function lastDigest(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    return lines.length ? JSON.parse(lines.at(-1)) : null;
  } catch {
    return null;
  }
}

/** The frozen verdict on a scratch session, or null. */
function frozenVerdictOf(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8')).reviewVerdict ?? null;
  } catch {
    return null;
  }
}

const phase = process.argv[2];

// `all` is the harness's own probe: it must prove THIS rig, self-contained, with
// no active forge session and no e2e.json in play. It checks only child exit
// codes, so every phase carries its own fail() assertions rather than leaning on
// the `expect` regexes in e2e.json — the gate has those, the probe does not, and
// a probe that only watches exit codes reports GREEN against a stubbed change.
if (phase === 'all') {
  for (const name of ['boot', 'record', 'show', 'red-run', 'quiet-cases']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      encoding: 'utf8',
      cwd: REPO,
    });
    process.stdout.write(`--- ${name} ---\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (r.status !== 0) {
      process.stderr.write(`\nHARNESS PROBE FAILED at phase "${name}" (exit ${r.status})\n`);
      process.exit(1);
    }
  }
  process.stdout.write('\nHARNESS PROBE GREEN — 5/5 phases\n');
  process.exit(0);
}

if (phase === 'boot') {
  // The review loop's control project is a *sibling* of SCRATCH, so the rmSync
  // inside makeProject does not reach it. Clear it here or it outlives every
  // documented `rm -rf $SCRATCH`.
  fs.rmSync(PROSE_PROJECT, { recursive: true, force: true });
  makeProject(SCRATCH);
  process.stdout.write(`SCRATCH PROJECT READY ${SCRATCH}\n`);
} else if (phase === 'record') {
  const { out, code } = forge(SCRATCH, [
    'e2e',
    'harness',
    '--set',
    'vite preview + playwright smoke',
    '--start',
    START_CMD,
    '--setup',
    SETUP_CMD,
    '--probe',
    PROBE_CMD,
    '--dir',
    'e2e',
  ]);
  if (code !== 0) fail(`recording exited ${code}`, out);
  // Read the committed artifact, not the CLI's own echo — the next session
  // reads this file, so this is the assertion that matters.
  const cfg = JSON.parse(fs.readFileSync(path.join(SCRATCH, '.forge', 'config.json'), 'utf8'));
  const h = cfg?.e2e?.harness ?? {};
  if (cfg?.plan?.engine !== 'specs') fail('harness write clobbered the plan config', JSON.stringify(cfg));
  if (h.setup !== SETUP_CMD) fail(`setup not recorded: ${h.setup}`, JSON.stringify(h, null, 2));
  if (h.probe !== PROBE_CMD) fail(`probe not recorded: ${h.probe}`, JSON.stringify(h, null, 2));
  if (h.start !== START_CMD) fail(`start not recorded: ${h.start}`, JSON.stringify(h, null, 2));
  process.stdout.write(`CONFIG e2e.harness.start=${h.start}\n`);
  process.stdout.write(`CONFIG e2e.harness.setup=${h.setup}\n`);
  process.stdout.write(`CONFIG e2e.harness.probe=${h.probe}\n`);
} else if (phase === 'show') {
  const shown = forge(SCRATCH, ['e2e', 'harness']);
  process.stdout.write(`${shown.out}\n`);
  // `forge e2e init` is where a later session meets the harness without going
  // looking for it — the prerequisite has to reach that surface too.
  const init = forge(SCRATCH, ['e2e', 'init', '--force']);
  process.stdout.write(`INIT\n${init.out}\n`);
  for (const [surface, text] of [
    ['forge e2e harness', shown.out],
    ['forge e2e init', init.out],
  ]) {
    for (const [label, value] of [
      ['Setup:', SETUP_CMD],
      ['Probe:', PROBE_CMD],
    ]) {
      if (!text.includes(label)) fail(`${surface} omitted the ${label} row`, text);
      if (!text.includes(value)) fail(`${surface} omitted the ${label} value`, text);
    }
  }
} else if (phase === 'red-run') {
  writeLoop(SCRATCH, false);
  const { out, code } = forge(SCRATCH, ['e2e', 'run']);
  process.stdout.write(`${out}\nEXIT ${code}\n`);
  if (code === 0) fail('a failing loop must exit non-zero', out);
  if (!out.includes(HINT)) fail('red loop did not name the recorded setup', out);
  if (!out.includes(SETUP_CMD)) fail('hint omitted the setup command itself', out);
  // Advisory before verdict: a hint printed after FAILED is a hint nobody reads.
  if (out.indexOf(SETUP_CMD) > out.indexOf('FAILED')) fail('hint printed after the verdict', out);
} else if (phase === 'quiet-cases') {
  // Green with a setup on file: the hint is for red runs only.
  writeLoop(SCRATCH, true);
  const green = forge(SCRATCH, ['e2e', 'run']);
  if (green.out.includes(HINT)) fail('green run printed the prerequisite hint', green.out);
  if (green.code !== 0) fail(`green loop exited ${green.code}`, green.out);
  process.stdout.write('NO HINT green-with-setup\n');

  // Red with no setup recorded: nothing to attribute, so say nothing.
  const bare = makeProject(`${SCRATCH}-bare`);
  forge(bare, ['e2e', 'harness', '--set', 'preview only', '--start', START_CMD]);
  writeLoop(bare, false);
  const red = forge(bare, ['e2e', 'run']);
  if (red.out.includes(HINT)) fail('hint printed with no recorded setup', red.out);
  if (red.code === 0) fail('a failing loop must exit non-zero', red.out);
  process.stdout.write('NO HINT red-without-setup\n');
} else if (phase === 'telemetry-collect') {
  // Layer a bound session and a synthetic host transcript onto `boot`'s
  // project, then run the shipped `forge metrics collect` over it.
  const sessionDir = path.join(SCRATCH, '.forge', 'sessions', 's1');
  const sessionFile = path.join(sessionDir, 'session.json');
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  session.createdAt = createdAt;
  session.updatedAt = at;
  session.phase = 'implement';
  session.tasksTotal = 1;
  session.tasksComplete = 1;
  session.host = { agent: 'claude-code', sessionIds: [HOST_ID], boundAt: createdAt };
  session.phaseHistory = [{ phase: 'implement', at: createdAt }];
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

  plantTranscripts(at);

  // Three dispatches, one of which the policy had to rewrite → skipped = 1.
  fs.writeFileSync(
    path.join(sessionDir, 'dispatches.jsonl'),
    `${[
      { ts: at, tool: 'Agent', decision: 'allow', modelRequested: 'opus', modelResolved: 'opus' },
      { ts: at, tool: 'Agent', decision: 'rewrite', modelRequested: 'sonnet', modelResolved: 'opus' },
      { ts: at, tool: 'Agent', decision: 'allow', modelRequested: 'opus', modelResolved: 'opus' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
    'utf8',
  );

  const { out, code } = forge(SCRATCH, ['metrics', 'collect'], { CLAUDE_CONFIG_DIR: HOST_CFG });
  if (code !== 0) fail(`forge metrics collect exited ${code}`, out);

  const doc = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
  if (doc.available !== true) fail('collector degraded on a planted transcript', doc.reason);
  const expected = PARENT_REQUESTS + SIDECAR_REQUESTS;
  if (doc.requests !== expected) {
    fail(`requests ${doc.requests}, expected ${expected} — per-content-block lines counted twice?`, out);
  }
  if (doc.subagents.length !== 1) fail(`subagents ${doc.subagents.length}, expected 1`, out);
  if (doc.dispatches.skipped !== 1) fail(`dispatchesSkipped ${doc.dispatches.skipped}, expected 1`, out);
  if (JSON.stringify(doc).includes('PRIVATE-E2E-DESCRIPTION')) {
    fail('a subagent description reached the persisted document', out);
  }

  process.stdout.write(
    `METRICS requests=${doc.requests} subagents=${doc.subagents.length} dispatchesSkipped=${doc.dispatches.skipped}\n`,
  );
} else if (phase === 'telemetry-analyze') {
  // The other half of the loop: finishing the session must collect, digest and
  // then be readable back as numbers by a separate command.
  const done = forge(
    SCRATCH,
    ['phase', 'done', '--allow-incomplete', 'e2e telemetry fixture'],
    { CLAUDE_CONFIG_DIR: HOST_CFG },
  );
  if (done.code !== 0) fail(`forge phase done exited ${done.code}`, done.out);

  const digest = JSON.parse(
    fs
      .readFileSync(path.join(SCRATCH, '.forge', 'sessions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .at(-1),
  );
  const expected = PARENT_REQUESTS + SIDECAR_REQUESTS;
  if (digest.metrics?.requests !== expected) {
    fail(`digest requests ${digest.metrics?.requests}, expected ${expected}`, JSON.stringify(digest));
  }
  if (digest.dispatchesSkipped !== 1) {
    fail(`digest dispatchesSkipped ${digest.dispatchesSkipped}, expected 1`, JSON.stringify(digest));
  }
  if (digest.subagentsDispatched !== 1) {
    fail(`digest subagentsDispatched ${digest.subagentsDispatched}, expected 1`, JSON.stringify(digest));
  }

  const analysis = forge(SCRATCH, ['analyze', '--json']);
  if (analysis.code !== 0) fail(`forge analyze exited ${analysis.code}`, analysis.out);
  const a = JSON.parse(analysis.stdout);
  const { sessionsWithMetrics, sessionsTotal } = a.coverage;
  if (sessionsWithMetrics !== 1 || sessionsTotal !== 1) {
    fail(`coverage ${sessionsWithMetrics}/${sessionsTotal}, expected 1/1`, analysis.stdout);
  }
  if (a.totals.requests !== expected) {
    fail(`analysis requests ${a.totals.requests}, expected ${expected}`, analysis.stdout);
  }
  if (a.dispatches.skipped !== 1) fail(`analysis skipped ${a.dispatches.skipped}`, analysis.stdout);
  const models = Object.keys(a.byModel);
  if (!models.some((m) => m.startsWith('claude-'))) fail('no model reached the analysis', analysis.stdout);

  process.stdout.write(
    `ANALYZE coverage=${sessionsWithMetrics}/${sessionsTotal} models=${models.sort().join(',')}\n`,
  );
} else if (phase === 'review-evidence-decides') {
  // EVIDENCE OUTRANKS PROSE. Two projects, one review file, byte for byte. One
  // has a host record of a real final reviewer and one has nothing but the
  // file; the verdicts must come out opposite.
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();

  // --- the control, and it runs FIRST on purpose ------------------------
  // If this fixture's prose would read as `independent` anyway, the evidence
  // half proves nothing at all — it would pass whether or not the host record
  // decided anything. So measure the prose-only reading before measuring
  // anything else, through the shipped binary rather than by importing the
  // classifier, because the claim is about what an operator's forge does.
  makeProject(PROSE_PROJECT);
  const control = layerReviewFixture(PROSE_PROJECT, { createdAt });
  plantNoHostRecord();

  // The gate's own answer to this prose: a high-risk change whose only reader
  // was its author is refused. Same file that passes below.
  const refused = forge(PROSE_PROJECT, ['phase', 'done'], { CLAUDE_CONFIG_DIR: EMPTY_HOST_CFG });
  if (refused.code === 0) {
    fail(
      'the money/auth done gate ACCEPTED the prose-only fixture — its review file does not read as ' +
        'a self-check, so nothing below proves that evidence outranks prose',
      // Trimmed on purpose. `runE2eSteps` reports only the last 30 lines, and
      // `fail()` prints its message before its context — a passing `phase done`
      // emits the whole session JSON, which pushes the assertion off the top and
      // the operator sees no message at all. Reproduced by an independent
      // reviewer against two separate breaks.
      tail(refused.out, 8),
    );
  }
  if (!refused.out.includes('self-authored')) {
    fail('the gate refused the control for some other reason than a self-authored review', refused.out);
  }

  // Same run again with the refusal recorded, so the transition completes and
  // the prose-only verdict is written down where it can be read back.
  const waived = forge(
    PROSE_PROJECT,
    ['phase', 'done', '--final-review-waived', 'e2e control: measuring the prose-only reading'],
    { CLAUDE_CONFIG_DIR: EMPTY_HOST_CFG },
  );
  if (waived.code !== 0) fail(`control forge phase done exited ${waived.code}`, waived.out);
  const prose = frozenVerdictOf(control.sessionDir);
  if (!prose) fail('no verdict was frozen onto the control session', waived.out);
  if (prose.final !== 'self' || prose.evidence !== 'inferred') {
    fail(
      `THE CONTROL IS THE TEST: read as prose alone this review file gives ` +
        `${prose.final}/${prose.evidence}, not self/inferred. A fixture whose prose already reads as ` +
        'independent makes the evidence half below pass for free.',
      SELF_CHECK_REVIEW,
    );
  }

  // --- the same file, with a host record beside it ----------------------
  const fixture = layerReviewFixture(SCRATCH, { createdAt, hostId: REVIEW_HOST_ID });
  plantReviewerDispatch(at);
  const same =
    fs.readFileSync(path.join(fixture.sessionDir, 'reviews', 'final-review.md'), 'utf8') ===
    fs.readFileSync(path.join(control.sessionDir, 'reviews', 'final-review.md'), 'utf8');
  if (!same) {
    fail('the two projects no longer share one review file — the control says nothing about this one');
  }

  // No --allow-incomplete and no waiver: this is the real money/auth gate, on
  // a high-risk change whose review file says its author reviewed it.
  const done = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (done.code !== 0) {
    fail(
      'forge phase done refused a change whose host recorded a real final reviewer — the review ' +
        "file's prose was consulted after all",
      done.out,
    );
  }
  const verdict = frozenVerdictOf(fixture.sessionDir);
  if (!verdict) fail('no verdict was frozen onto the session', done.out);
  if (verdict.evidence !== 'host') {
    fail(`verdict graded ${verdict.evidence}, expected host — the dispatch record did not decide`, done.out);
  }
  if (verdict.final !== 'independent') {
    fail(`verdict ${verdict.final} on host evidence, expected independent`, done.out);
  }
  // Deliberately not asserting `stoppedByOperator` here. This fixture's meta
  // carries no `stoppedByUser`, so the flag is false by construction and the
  // assertion could never fail — hard-coding it in `review-census.mjs` left the
  // whole loop green. The declined-dispatch rule is covered by unit tests; it
  // has no step in this contract, and pretending otherwise is worse than the gap.

  // Derived, never spelled out: if an assertion above is ever loosened, the
  // gate's `expect` still catches the wrong answer at this line.
  process.stdout.write(
    `REVIEW final=${verdict.final} evidence=${verdict.evidence} ` +
      `prose=${prose.final === 'self' ? 'self-check' : prose.final}\n`,
  );
} else if (phase === 'review-evidence-survives') {
  // THE VERDICT OUTLIVES ITS EVIDENCE. The host prunes transcripts in days; the
  // durable digest is forever. Delete the record that decided, then make forge
  // re-derive everything that reads the verdict and prove nothing moved.
  const sessionDir = path.join(SCRATCH, '.forge', 'sessions', 's1');
  const digestFile = path.join(SCRATCH, '.forge', 'sessions.jsonl');
  const before = lastDigest(digestFile);
  if (!before) fail('no durable digest line — run review-evidence-decides first', digestFile);
  if (before.reviews?.final !== 'independent' || before.reviews?.evidence !== 'host') {
    // Only the reviews block: the whole digest entry is long enough to push
    // this message out of the runner's 30-line tail.
    fail(
      'the digest did not carry the measured verdict into this phase',
      JSON.stringify(before.reviews),
    );
  }
  if (typeof before.reviews?.rule !== 'number') {
    fail('the digest does not record which classifier judged it', JSON.stringify(before, null, 2));
  }

  const transcript = path.join(
    REVIEW_HOST_CFG,
    'projects',
    REVIEW_PROJECT_DIR,
    `${REVIEW_HOST_ID}.jsonl`,
  );
  if (!fs.existsSync(transcript)) fail('the host transcript was already gone before the prune', transcript);
  fs.rmSync(REVIEW_HOST_CFG, { recursive: true, force: true });
  if (fs.existsSync(transcript)) fail('the prune did not remove the host transcript', transcript);
  process.stdout.write(`PRUNED ${REVIEW_HOST_CFG}\n`);

  // 1. the gate. A second `forge phase done` now measures nothing, and must
  //    keep the answer it already has rather than falling back to the prose —
  //    which, per the control in the previous phase, says self-check.
  const again = forge(SCRATCH, ['phase', 'done'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  if (again.code !== 0) {
    fail(
      'the money/auth gate refused a session whose evidence has been pruned — the verdict did not ' +
        'outlive it, and an operator would be asked to re-dispatch a reviewer that already ran',
      again.out,
    );
  }
  if (!again.out.includes('Kept the review verdict')) {
    fail('forge re-measured instead of keeping the frozen verdict', again.out);
  }
  // And it must still say so on disk: a pass that keeps the gate open but
  // degrades the stored verdict would strand every later reader.
  const kept = frozenVerdictOf(sessionDir);
  if (kept?.final !== 'independent' || kept?.evidence !== 'host') {
    fail('the verdict frozen on the session degraded once its evidence was pruned', JSON.stringify(kept));
  }

  // 2. the durable line. Delete it outright so `forge score --write` has to
  //    build it again from nothing, with no transcript left anywhere on disk.
  fs.rmSync(digestFile, { force: true });
  const scored = forge(SCRATCH, ['score', '--write'], { CLAUDE_CONFIG_DIR: REVIEW_HOST_CFG });
  /** @type {Record<string, any>} */
  let card;
  try {
    card = JSON.parse(scored.stdout);
  } catch {
    fail(`forge score printed no scorecard (exit ${scored.code})`, scored.out);
  }
  const after = lastDigest(digestFile);
  if (!after) fail('forge score --write did not re-derive the durable digest line', scored.out);

  // 3. the scorecard. Its 29-point money/auth cap reads the same verdict, and
  //    a live prose census here would both flip the note and apply the cap.
  const reviews = (card.checks ?? []).find((c) => c?.id === 'reviews');
  const notes = (reviews?.notes ?? []).join(' | ');
  if (!notes.includes('independent final review')) {
    fail('the scorecard fell back to the review file once the evidence was gone', notes);
  }
  const cap = (card.caps ?? []).find((c) => String(c).includes('self-authored'));
  if (cap) fail('the high-risk cap was applied to an independently reviewed session', String(cap));

  const unchanged = JSON.stringify(after.reviews) === JSON.stringify(before.reviews);
  process.stdout.write(
    `DIGEST final=${after.reviews?.final} evidence=${after.reviews?.evidence} ` +
      `afterPrune=${unchanged ? 'unchanged' : 'changed'}\n`,
  );
  if (!unchanged) {
    fail(
      'the durable verdict moved once its evidence was pruned',
      `before ${JSON.stringify(before.reviews)}\nafter  ${JSON.stringify(after.reviews)}`,
    );
  }
} else if (phase === 'session-ambiguity') {
  // THE REGRESSION THAT MUST NEVER COME BACK. `.forge/active.json` is written by
  // `forge new` alone, so "active" means *most recently created*. Before this
  // change, a bare `forge phase done` with two sessions open gated whichever one
  // the pointer happened to name: it scored that change, wrote its permanent
  // ledger line, and left the other — the one actually being finished — with no
  // verdict, no scorecard and no trip through the money/auth floor at all.
  //
  // The severity split is the operator's: `done`/`finish` refuse because their
  // damage is unrecoverable; every other phase warns and carries on, because
  // being wrong at `implement` costs a re-run and refusing there would block
  // ordinary work in any project with two sessions open.
  const project = makeProject(`${SCRATCH}-ambiguity`);
  const second = path.join(project, '.forge', 'sessions', 's2');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(
    path.join(second, 'session.json'),
    `${JSON.stringify({ id: 's2', slug: 'neighbour', phase: 'implement' })}\n`,
  );

  const gated = forge(project, ['phase', 'done']);
  if (gated.code === 0) {
    fail(
      'forge phase done picked a session for itself with two open',
      'this is the defect: it scores and files whichever the pointer names, and the other change never reaches the floor',
    );
  }
  for (const needle of ['Refusing to guess', '--session s1', '--session s2']) {
    if (!gated.out.includes(needle)) {
      fail(`the refusal did not name ${needle}`, tail(gated.out, 20));
    }
  }
  // And it must have changed nothing at all.
  if (fs.existsSync(path.join(project, '.forge', 'sessions.jsonl'))) {
    fail('a refused gate wrote a durable ledger line');
  }
  if (fs.existsSync(path.join(project, '.forge', 'sessions', 's1', 'scorecard.json'))) {
    fail('a refused gate wrote a scorecard');
  }

  // A reversible phase is deliberately NOT refused. `verify` rather than
  // `implement` because implement has its own brief gate, and a refusal from
  // that would look identical to the one under test.
  const soft = forge(project, ['phase', 'verify']);
  if (soft.code !== 0) {
    fail('a reversible phase refused instead of warning', tail(soft.out, 20));
  }
  if (!soft.out.includes('sessions are unfinished')) {
    fail('a reversible phase proceeded silently', tail(soft.out, 20));
  }

  // AND IT MUST HAVE ACTED ON THE POINTER'S SESSION, NOT THE OTHER ONE. Warning
  // about ambiguity and then transitioning the neighbour is the original defect
  // wearing a diagnostic. Checked here because the loop asserted the *refuse*
  // side and merely that the *warn* side warned — a mutant that warned and then
  // acted on the wrong session shipped this loop green.
  const s1 = JSON.parse(
    fs.readFileSync(path.join(project, '.forge', 'sessions', 's1', 'session.json'), 'utf8'),
  );
  const s2 = JSON.parse(
    fs.readFileSync(path.join(project, '.forge', 'sessions', 's2', 'session.json'), 'utf8'),
  );
  if (s1.phase !== 'verify') {
    fail('the warn path did not transition the session active.json names', `s1.phase = ${s1.phase}`);
  }
  if (s2.phase !== 'implement') {
    fail('the warn path transitioned the neighbour', `s2.phase = ${s2.phase}`);
  }

  process.stdout.write(
    `AMBIGUITY done=refused verify=warned+acted-on-s1 neighbour=untouched candidates=2\n`,
  );
} else {
  process.stderr.write(
    'Usage: harness-portability.mjs all|boot|record|show|red-run|quiet-cases|telemetry-collect|' +
      'telemetry-analyze|review-evidence-decides|review-evidence-survives|session-ambiguity\n',
  );
  process.exit(1);
}
