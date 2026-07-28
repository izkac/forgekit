import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'metrics-cli.mjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * A fixture transcript, described as data so every expected total below is
 * derived from it rather than quoted by hand.
 *
 * `lines` is how many transcript lines the host wrote for that one request —
 * it repeats the whole `usage` object per content block, so a CLI that sums
 * lines instead of requests would report inflated totals here.
 */
const REQUESTS = [
  {
    id: 'req_aaa',
    model: 'claude-opus-5',
    lines: 3,
    usage: { input: 12, output: 640, cacheRead: 20606, cacheCreate: 9174 },
  },
  {
    id: 'req_bbb',
    model: 'claude-opus-5',
    lines: 1,
    usage: { input: 3, output: 91, cacheRead: 41, cacheCreate: 0 },
  },
  {
    id: 'req_ccc',
    model: 'claude-fable-5',
    lines: 2,
    usage: { input: 7, output: 12, cacheRead: 1002, cacheCreate: 55 },
  },
];

const EXPECTED = {
  requests: REQUESTS.length,
  tokens: ['input', 'output', 'cacheRead', 'cacheCreate'].reduce(
    (acc, field) => ({ ...acc, [field]: REQUESTS.reduce((sum, r) => sum + r.usage[field], 0) }),
    {},
  ),
  models: [...new Set(REQUESTS.map((r) => r.model))].sort(),
};

/**
 * A host transcript under a scratch CLAUDE_CONFIG_DIR, stamped inside the
 * session window.
 *
 * @param {string} configDir
 * @param {string} hostId
 * @param {string} at ISO timestamp for every line
 * @returns {string} the transcript path
 */
function writeTranscript(configDir, hostId, at) {
  const projectDir = path.join(configDir, 'projects', '-scratch-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [];
  for (const request of REQUESTS) {
    for (let block = 0; block < request.lines; block += 1) {
      lines.push({
        type: 'assistant',
        requestId: request.id,
        timestamp: at,
        version: '2.1.220',
        isSidechain: false,
        message: {
          id: `msg_${request.id}`,
          model: request.model,
          content: [{ type: 'tool_use', id: `toolu_${request.id}_${block}`, name: 'Bash' }],
          usage: {
            input_tokens: request.usage.input,
            output_tokens: request.usage.output,
            cache_read_input_tokens: request.usage.cacheRead,
            cache_creation_input_tokens: request.usage.cacheCreate,
          },
        },
      });
    }
  }
  lines.push({
    type: 'user',
    timestamp: at,
    message: {
      content: [{ type: 'tool_result', tool_use_id: `toolu_${REQUESTS[0].id}_0`, is_error: true }],
    },
  });
  const file = path.join(projectDir, `${hostId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  return file;
}

/**
 * Scratch forge layout: active.json plus one session, optionally bound to a
 * host session id. Timestamps are explicit so the collector's window is a
 * fact of the fixture rather than of how fast the test runs.
 *
 * @param {string} dir
 * @param {string} sessionId
 * @param {{ host?: string[], active?: boolean }} [opts]
 * @returns {{ sessionDir: string, createdAt: string, activityAt: string }}
 */
function makeSession(dir, sessionId, opts = {}) {
  const sessionDir = path.join(dir, '.forge', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  const activityAt = new Date(Date.now() - 1800_000).toISOString();
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify(
      {
        id: sessionId,
        slug: 'fixture',
        createdAt,
        updatedAt: activityAt,
        phase: 'implement',
        tasksTotal: 3,
        tasksComplete: 3,
        host: opts.host ? { agent: 'claude-code', sessionIds: opts.host, boundAt: createdAt } : null,
        phaseHistory: [{ phase: 'implement', at: createdAt }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (opts.active !== false) {
    fs.writeFileSync(
      path.join(dir, '.forge', 'active.json'),
      `${JSON.stringify({ sessionId }, null, 2)}\n`,
      'utf8',
    );
  }
  return { sessionDir, createdAt, activityAt };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function run(cwd, args, env = {}) {
  // The suite may itself run inside a host session; a test that means "no
  // host" must get one wherever it runs.
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ID;
  delete base.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

function readMetrics(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'metrics.json'), 'utf8'));
}

test('forge metrics collect harvests the bound transcript into metrics.json', () => {
  const dir = tmp('forge-metrics-cli-');
  const configDir = tmp('forge-metrics-cfg-');
  try {
    const { sessionDir, activityAt } = makeSession(dir, 'sess-collect', { host: ['host-1'] });
    writeTranscript(configDir, 'host-1', activityAt);

    fs.writeFileSync(
      path.join(sessionDir, 'dispatches.jsonl'),
      `${JSON.stringify({ decision: 'allow' })}\n${JSON.stringify({ decision: 'deny' })}\n`,
      'utf8',
    );

    const r = run(dir, ['collect'], { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(r.status, 0, r.stderr);

    const doc = readMetrics(sessionDir);
    assert.equal(doc.dispatches.total, 2, 'the session dir reaches the collector');
    assert.equal(doc.dispatches.skipped, 1);
    assert.equal(doc.available, true, JSON.stringify(doc));
    assert.equal(
      doc.requests,
      EXPECTED.requests,
      'the host repeats usage per content block — the CLI must report requests, not lines',
    );
    assert.deepEqual(doc.tokens, EXPECTED.tokens);
    assert.deepEqual(Object.keys(doc.byModel).sort(), EXPECTED.models);
    assert.equal(doc.errors.errorResults, 1);
    assert.match(r.stdout, new RegExp(String(EXPECTED.requests)), 'summary names the request count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('--json prints the document it wrote, byte for byte the same numbers', () => {
  const dir = tmp('forge-metrics-cli-json-');
  const configDir = tmp('forge-metrics-cfg-json-');
  try {
    const { sessionDir, activityAt } = makeSession(dir, 'sess-json', { host: ['host-1'] });
    writeTranscript(configDir, 'host-1', activityAt);

    const r = run(dir, ['collect', '--json'], { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(r.status, 0, r.stderr);

    const printed = JSON.parse(r.stdout);
    assert.equal(printed.requests, EXPECTED.requests);
    assert.deepEqual(printed.tokens, EXPECTED.tokens);
    assert.deepEqual(printed, readMetrics(sessionDir), 'stdout and the file must not disagree');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('an unbound session is a normal outcome: available:false, written, exit 0', () => {
  // Cursor, Codex, a plain shell, a pruned transcript. None of these is a
  // command failure, and a non-zero exit here would break `forge phase done`.
  const dir = tmp('forge-metrics-cli-unbound-');
  try {
    const { sessionDir } = makeSession(dir, 'sess-unbound');

    const r = run(dir, ['collect']);
    assert.equal(r.status, 0, r.stderr);

    const doc = readMetrics(sessionDir);
    assert.equal(doc.available, false);
    assert.ok(doc.reason && typeof doc.reason === 'string', 'a degraded document must say why');
    assert.match(r.stdout + r.stderr, /no host session bound/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--session targets a session that is not the active one', () => {
  const dir = tmp('forge-metrics-cli-target-');
  const configDir = tmp('forge-metrics-cfg-target-');
  try {
    makeSession(dir, 'sess-active', { host: ['host-active'] });
    const other = makeSession(dir, 'sess-other', { host: ['host-other'], active: false });
    writeTranscript(configDir, 'host-other', other.activityAt);

    const r = run(dir, ['collect', '--session', 'sess-other'], { CLAUDE_CONFIG_DIR: configDir });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(readMetrics(other.sessionDir).requests, EXPECTED.requests);
    assert.equal(
      fs.existsSync(path.join(dir, '.forge', 'sessions', 'sess-active', 'metrics.json')),
      false,
      'the active session must not be collected when another was named',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('misuse exits non-zero and writes nothing', () => {
  const dir = tmp('forge-metrics-cli-misuse-');
  try {
    fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });

    const noSession = run(dir, ['collect']);
    assert.equal(noSession.status, 1);
    assert.match(noSession.stderr, /No active session/);

    makeSession(dir, 'sess-misuse');
    const unknownId = run(dir, ['collect', '--session', 'nope']);
    assert.equal(unknownId.status, 1);
    assert.match(unknownId.stderr, /nope/);

    const badFlag = run(dir, ['collect', '--wat']);
    assert.equal(badFlag.status, 1);
    assert.match(badFlag.stderr, /--wat/);

    const badSub = run(dir, ['analyse']);
    assert.equal(badSub.status, 1);
    assert.match(badSub.stderr, /analyse/);

    const noValue = run(dir, ['collect', '--session']);
    assert.equal(noValue.status, 1);
    assert.match(noValue.stderr, /--session needs a session id/);

    const bare = run(dir, []);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /Usage/);

    assert.equal(
      fs.existsSync(path.join(dir, '.forge', 'sessions', 'sess-misuse', 'metrics.json')),
      false,
      'a rejected command must not leave a half-considered document behind',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help explains the command and exits 0', () => {
  const dir = tmp('forge-metrics-cli-help-');
  try {
    const r = run(dir, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /forge metrics collect/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command is registered under `forge metrics`', () => {
  // A src/*.mjs nobody can reach from the bin is a stub with extra steps.
  const bin = path.join(path.dirname(SCRIPT), '..', 'bin', 'forge.mjs');
  const dir = tmp('forge-metrics-cli-bin-');
  const configDir = tmp('forge-metrics-cfg-bin-');
  try {
    const { sessionDir, activityAt } = makeSession(dir, 'sess-bin', { host: ['host-1'] });
    writeTranscript(configDir, 'host-1', activityAt);

    const base = { ...process.env };
    delete base.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [bin, 'metrics', 'collect'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...base, CLAUDE_CONFIG_DIR: configDir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readMetrics(sessionDir).requests, EXPECTED.requests);
    assert.match(
      fs.readFileSync(bin, 'utf8'),
      /^ {2}metrics /m,
      'a registered command that is missing from --help is undiscoverable',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
