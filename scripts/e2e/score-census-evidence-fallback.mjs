#!/usr/bin/env node
/**
 * Product loop for score-census-evidence-fallback (F63) — plant a stamped
 * final review with host evidence of a measured operator stop, then drive the
 * live digest path (no frozen reviewVerdict) and assert the stamp does not
 * grade recorded independence.
 *
 * Status line (exact): `CENSUS-EVIDENCE live-stop=ok`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSessionDigest, readLedger } from '../../packages/cli/src/ledger.mjs';
import { FINAL_REVIEW_REQUEST_FLOOR, reviewCensus } from '../../packages/cli/src/review-census.mjs';
import { writeStamp } from '../../packages/cli/src/review-stamp.mjs';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

/**
 * Host transcript + stopped final-reviewer sidecar under a scratch
 * CLAUDE_CONFIG_DIR — same shape as ledger.test.mjs / score.test.mjs.
 *
 * @param {string} configDir
 * @param {string} hostId
 * @param {string} at
 * @param {string} forgeSessionId
 */
function plantStoppedFinalDispatch(configDir, hostId, at, forgeSessionId) {
  const projectDir = path.join(configDir, 'projects', '-scratch');
  fs.mkdirSync(projectDir, { recursive: true });
  const parentLine = {
    type: 'assistant',
    requestId: 'parent_1',
    timestamp: at,
    message: {
      id: 'msg_parent_1',
      model: 'claude-opus-5',
      content: [{ type: 'text' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
  fs.writeFileSync(
    path.join(projectDir, `${hostId}.jsonl`),
    `${JSON.stringify(parentLine)}\n`,
    'utf8',
  );
  const sidecarDir = path.join(projectDir, hostId, 'subagents');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-r1.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: `forge-review final ${forgeSessionId}`,
      model: 'opus',
      stoppedByUser: true,
    }),
    'utf8',
  );
  const lines = Array.from({ length: FINAL_REVIEW_REQUEST_FLOOR }, (_, i) => ({
    type: 'assistant',
    requestId: `req_r1_${i}`,
    timestamp: at,
    message: {
      id: `msg_r1_${i}`,
      model: 'claude-opus-5',
      content: [{ type: 'text' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  }));
  fs.writeFileSync(
    path.join(sidecarDir, 'agent-r1.jsonl'),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    'utf8',
  );
}

const root = tmp('forgekit-e2e-census-evidence-');
const configDir = tmp('forgekit-e2e-census-evidence-cfg-');
const prevConfig = process.env.CLAUDE_CONFIG_DIR;
const sessionId = 'sess-e2e-census-live-stop';
const hostId = 'host-e2e-census-live-stop';
const createdAt = '2026-07-28T10:00:00.000Z';

try {
  const sessionDir = path.join(root, '.forge', 'sessions', sessionId);
  fs.mkdirSync(path.join(sessionDir, 'tasks', '01-model'), { recursive: true });
  const session = {
    id: sessionId,
    slug: 'census-evidence-e2e',
    openspecChange: 'census-evidence-e2e',
    phase: 'done',
    planType: 'specs',
    tasksTotal: 2,
    tasksComplete: 2,
    createdAt,
    updatedAt: '2026-07-28T14:00:00.000Z',
    // No reviewVerdict — live-census fallback is what F63 names.
    host: { agent: 'claude-code', sessionIds: [hostId], boundAt: createdAt },
  };
  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );

  fs.mkdirSync(path.join(sessionDir, 'reviews'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'reviews', 'final-review.md'),
    '# Final review\n\n**Verdict: APPROVED** — opus reviewer 4d2 read the whole diff.\n',
    'utf8',
  );

  writeStamp(sessionDir, {
    unit: 'final',
    label: `forge-review final ${sessionId}`,
    sessionId,
  });
  plantStoppedFinalDispatch(configDir, hostId, createdAt, sessionId);
  process.env.CLAUDE_CONFIG_DIR = configDir;

  // Control: without evidence the stamp alone decides this session.
  const bare = reviewCensus(sessionDir);
  if (bare.finalReviewEvidence !== 'recorded') {
    fail(
      `fixture: stamp alone must grade recorded, got evidence=${bare.finalReviewEvidence}`,
    );
  }
  if (bare.finalReview !== 'independent') {
    fail(`fixture: stamp alone must grade independent, got final=${bare.finalReview}`);
  }

  appendSessionDigest({ cwd: root, sessionDir, session, card: null });
  const [entry] = readLedger(path.join(root, '.forge', 'sessions.jsonl'));
  if (!entry?.reviews) {
    fail('digest missing reviews after appendSessionDigest');
  }
  const { final, evidence, stoppedByOperator } = entry.reviews;

  if (final === 'independent' || evidence === 'recorded') {
    fail(
      `stamp must not win as recorded independence, got final=${final} evidence=${evidence}`,
    );
  }
  if (final !== 'self') {
    fail(`expected final=self (measured stop outranks stamp), got final=${final}`);
  }
  if (evidence !== 'host') {
    fail(`expected evidence=host, got evidence=${evidence}`);
  }
  if (stoppedByOperator !== true) {
    fail(`expected stoppedByOperator=true, got ${stoppedByOperator}`);
  }

  process.stdout.write('CENSUS-EVIDENCE live-stop=ok\n');
} finally {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
}
