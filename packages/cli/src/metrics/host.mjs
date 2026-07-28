/**
 * Bind a Forge session to the host agent session that is driving it.
 *
 * A Forge session knows how disciplined it was — score, reviews, deferrals —
 * but nothing about how it actually ran: tokens burnt, models used, tools that
 * failed. The host already writes all of that to disk as JSONL transcripts;
 * the only missing link is *which* transcripts belong to this session.
 *
 * That link is an environment variable. `CLAUDE_CODE_SESSION_ID` is exported
 * into the shell `forge` runs in, and its value is the transcript's basename,
 * so binding needs no hook installed and does not care whether the Forge
 * session existed when the host session started. A session resumed tomorrow
 * under a new host id simply appends the new id.
 *
 *   ~/.claude/projects/<munged-cwd>/<host-session-id>.jsonl      main
 *   ~/.claude/projects/<munged-cwd>/<host-session-id>/subagents/ sidecars
 *
 * `findTranscripts` globs `projects/*` rather than reconstructing the munged
 * directory name: that munging rule is undocumented, and host session ids are
 * unique anyway, so a scan is both exact and immune to the rule changing.
 *
 * Everything here is advisory. Telemetry must never throw, never block a
 * phase transition, and never fail a command — a missing transcript or an
 * unreadable directory degrades the result, it does not raise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which host agent is running this command, and under what session id.
 *
 * `AI_AGENT` (e.g. `claude-code_2-1-220_agent`) is deliberately ignored: its
 * shape is version-dependent and not a contract, so the presence of a session
 * id — the thing we actually need to find transcripts — is what decides.
 *
 * @param {Record<string, string | undefined> | undefined | null} [env]
 * @returns {{ agent: string, sessionId: string | null }}
 */
export function detectHost(env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.CLAUDE_CODE_SESSION_ID;
  const sessionId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return sessionId ? { agent: 'claude-code', sessionId } : { agent: 'unknown', sessionId: null };
}

/**
 * Record the host binding on a session object, in place.
 *
 * Additive by design: ids accumulate without duplicates, `boundAt` marks the
 * first bind only, and a command run with no host environment never erases a
 * binding made by an earlier one.
 *
 * @template {Record<string, any>} T
 * @param {T} session
 * @param {Record<string, string | undefined> | undefined | null} [env]
 * @param {() => Date} [now]
 * @returns {T} the same session object
 */
export function bindHost(session, env, now = () => new Date()) {
  if (!session || typeof session !== 'object') return session;

  const { agent, sessionId } = detectHost(env);
  // Anything that is not a plain object — an array included, since it passes
  // `typeof === 'object'` and would then swallow the binding — counts as no
  // binding at all and is replaced.
  const existing = session.host;
  const host =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : (session.host = {});

  if (!Array.isArray(host.sessionIds)) host.sessionIds = [];

  if (!sessionId) {
    // No host to bind to; only fill in a placeholder agent, never downgrade.
    if (typeof host.agent !== 'string' || !host.agent) host.agent = agent;
    return session;
  }

  // Stamped by the first id actually recorded — a boundAt on a session with no
  // ids would name a moment when nothing was bound.
  if (!host.boundAt) host.boundAt = now().toISOString();
  host.agent = agent;
  if (!host.sessionIds.includes(sessionId)) host.sessionIds.push(sessionId);
  return session;
}

/**
 * @param {{ configDir?: string, homedir?: () => string, env?: Record<string, string | undefined> }} opts
 * @returns {string}
 */
function resolveConfigDir(opts) {
  if (typeof opts.configDir === 'string' && opts.configDir) return path.resolve(opts.configDir);
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const home = (opts.homedir ?? os.homedir)();
  return path.join(path.resolve(home), '.claude');
}

/**
 * Locate the transcript on disk for each host session id.
 *
 * Ids with no transcript are omitted rather than reported: a pruned or
 * foreign session is a normal condition, not an error.
 *
 * @param {string[]} sessionIds
 * @param {{ configDir?: string, homedir?: () => string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ sessionId: string, transcript: string, sidecarDir: string | null }[]}
 */
export function findTranscripts(sessionIds, opts = {}) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(
    (id) => typeof id === 'string' && id,
  );
  if (ids.length === 0) return [];

  let projectsDir;
  /** @type {string[]} */
  let projects;
  try {
    projectsDir = path.join(resolveConfigDir(opts ?? {}), 'projects');
    projects = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return []; // no projects dir, or it is unreadable — advisory
  }

  /** @type {{ sessionId: string, transcript: string, sidecarDir: string | null }[]} */
  const found = [];
  for (const sessionId of ids) {
    for (const project of projects) {
      const transcript = path.join(projectsDir, project, `${sessionId}.jsonl`);
      try {
        if (!fs.statSync(transcript).isFile()) continue;
      } catch {
        continue;
      }
      const sidecar = path.join(projectsDir, project, sessionId, 'subagents');
      let sidecarDir = null;
      try {
        if (fs.statSync(sidecar).isDirectory()) sidecarDir = sidecar;
      } catch {
        // sidecars are optional — a session may have dispatched no subagents
      }
      found.push({ sessionId, transcript, sidecarDir });
      break; // ids are unique; first hit wins
    }
  }
  return found;
}
