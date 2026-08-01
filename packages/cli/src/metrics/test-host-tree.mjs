/**
 * Shared Claude host-tree fixtures for metrics / review-evidence / census tests.
 *
 * Plants `~/.claude/projects/<slug>/…` layouts used by collect, reviewEvidence,
 * and review-census join tests. Cursor plants stay local to collect.test.mjs;
 * transcript.test.mjs keeps its richer assistantLine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

/** Stable UUID reused across collect / review-evidence host fixtures. */
export const DEFAULT_HOST_ID = 'f8447a2f-eb56-41b8-8cc1-16606b862780';

/** Munged cwd slug under `projects/` — findTranscripts globs all of them. */
const DEFAULT_PROJECT_SLUG = '-home-iztok-Projects-forgekit';

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A `usage` object in the host's own field names. */
export function usage({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
}

/**
 * One assistant transcript line — i.e. one content block of one reply.
 *
 * Collect-shaped defaults (`isSidechain: false`, `version`, optional `block`).
 * Pass `isSidechain: true` for sidecar / review-evidence-shaped lines.
 */
export function assistantLine({
  requestId,
  at,
  model = 'claude-opus-5',
  tokens = {},
  block = { type: 'text' },
  version = '2.1.220',
  isSidechain = false,
  ...rest
} = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: at,
    version,
    isSidechain,
    ...rest,
    message: { id: `msg_${requestId}`, model, content: [block], usage: usage(tokens) },
  };
}

export function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
}

/** A meta in the host's own shape; `stoppedByUser` is absent unless asked for. */
export function meta({ description, stoppedByUser } = {}) {
  const out = {
    agentType: 'general-purpose',
    description,
    toolUseId: 'toolu_017uFdNuuRF9FFhJk8oz15Gr',
    spawnDepth: 1,
    model: 'opus',
  };
  if (stoppedByUser !== undefined) out.stoppedByUser = stoppedByUser;
  return out;
}

/**
 * Lay out `agent-<id>.meta.json` / `agent-<id>.jsonl` pairs in a fresh dir,
 * exactly as the host writes them. Omit either half to model a killed or
 * pruned dispatch.
 */
export function plantSidecars(agents, dir = tmp('forge-host-tree-sidecars-')) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [agentId, { meta: agentMeta, lines }] of Object.entries(agents)) {
    if (agentMeta !== undefined) {
      fs.writeFileSync(
        path.join(dir, `agent-${agentId}.meta.json`),
        typeof agentMeta === 'string' ? agentMeta : JSON.stringify(agentMeta),
      );
    }
    if (lines !== undefined) {
      fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), jsonl(lines));
    }
  }
  return dir;
}

/**
 * Plant a `~/.claude`-shaped tree and return its config dir. Pass `configDir`
 * (the value this same function returned) to plant a second host session
 * beside the first, rather than into a fresh tree of its own — a session
 * bound to several host ids has them all under one project directory.
 *
 * `subagents` maps agent id → `{ meta, lines }`, exactly as the host lays them
 * out beside the parent transcript.
 */
export function plantHost({
  sessionId = DEFAULT_HOST_ID,
  lines = null,
  subagents = null,
  configDir = tmp('forge-host-tree-'),
  projectSlug = DEFAULT_PROJECT_SLUG,
} = {}) {
  const project = path.join(configDir, 'projects', projectSlug);
  fs.mkdirSync(project, { recursive: true });
  if (lines !== null) fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), jsonl(lines));
  if (subagents !== null) plantSidecars(subagents, path.join(project, sessionId, 'subagents'));
  return configDir;
}
