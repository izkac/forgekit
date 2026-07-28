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
} else {
  process.stderr.write(
    'Usage: harness-portability.mjs all|boot|record|show|red-run|quiet-cases|telemetry-collect|telemetry-analyze\n',
  );
  process.exit(1);
}
