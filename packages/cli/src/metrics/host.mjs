/**
 * Bind a Forge session to the host agent session that is driving it.
 *
 * A Forge session knows how disciplined it was — score, reviews, deferrals —
 * but nothing about how it actually ran: tokens burnt, models used, tools that
 * failed. The host already writes all of that to disk as JSONL transcripts;
 * the only missing link is *which* transcripts belong to this session.
 *
 * That link is an environment variable. `CLAUDE_CODE_SESSION_ID` is exported
 * into the shell `forge` runs in (Claude Code), and its value is the
 * transcript's basename. Cursor exports `CURSOR_CONVERSATION_ID` (preferred)
 * or `CURSOR_TRACE_ID`. Binding needs no hook and does not care whether the
 * Forge session existed when the host session started. A session resumed
 * tomorrow under a new host id simply appends the new id.
 *
 *   ~/.claude/projects/<munged-cwd>/<host-session-id>.jsonl      main
 *   ~/.claude/projects/<munged-cwd>/<host-session-id>/subagents/ sidecars
 *
 *   ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl  Cursor main
 *   ~/.cursor/projects/<slug>/agent-transcripts/<id>/subagents/  Cursor sidecars
 *
 * `findTranscripts` globs each host's `projects/*` rather than reconstructing
 * the munged directory name: that munging rule is undocumented, and host
 * session ids are unique anyway, so a scan is both exact and immune to the
 * rule changing. Claude is searched first; ids still missing are then sought
 * under Cursor's agent-transcripts layout. Locating Cursor files is
 * implemented; parsing Cursor `{role,message}` lines into token usage is not.
 *
 * Everything here is advisory. Telemetry must never throw, never block a
 * phase transition, and never fail a command — a missing transcript or an
 * unreadable directory degrades the result, it does not raise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Which host agent is running this command, and under what session id.
 *
 * `AI_AGENT` (e.g. `claude-code_2-1-220_agent`) is deliberately ignored: its
 * shape is version-dependent and not a contract, so the presence of a session
 * id — the thing we actually need to find transcripts — is what decides.
 * Claude's id wins when both Claude and Cursor markers are present.
 *
 * @param {Record<string, string | undefined> | undefined | null} [env]
 * @returns {{ agent: string, sessionId: string | null }}
 */
export function detectHost(env) {
  const source = env && typeof env === 'object' ? env : {};
  const claudeId = nonEmpty(source.CLAUDE_CODE_SESSION_ID);
  if (claudeId) return { agent: 'claude-code', sessionId: claudeId };

  const cursorId =
    nonEmpty(source.CURSOR_CONVERSATION_ID) || nonEmpty(source.CURSOR_TRACE_ID);
  if (cursorId) return { agent: 'cursor', sessionId: cursorId };

  return { agent: 'unknown', sessionId: null };
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

  // Cursor conversation id doubles as chat id when the session has none yet
  // (--chat-id and prior binds win). Trace-only binds do not set cursorChatId.
  const conversationId = nonEmpty(
    env && typeof env === 'object' ? env.CURSOR_CONVERSATION_ID : null,
  );
  if (conversationId && (session.cursorChatId == null || session.cursorChatId === '')) {
    session.cursorChatId = conversationId;
  }

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
 * @param {{ cursorProjectsDir?: string, homedir?: () => string }} opts
 * @returns {string}
 */
function resolveCursorProjectsDir(opts) {
  if (typeof opts.cursorProjectsDir === 'string' && opts.cursorProjectsDir) {
    return path.resolve(opts.cursorProjectsDir);
  }
  const home = (opts.homedir ?? os.homedir)();
  return path.join(path.resolve(home), '.cursor', 'projects');
}

/**
 * List immediate child directory names under `projectsDir`, or null when the
 * directory is missing / unreadable (advisory — caller treats that as "no
 * projects to search", not as failure of the whole locate).
 *
 * @param {string} projectsDir
 * @returns {string[] | null}
 */
function listProjectDirs(projectsDir) {
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

/**
 * Stat one transcript + optional sidecar under a single project slug, using
 * the same found / unreadable / omit rules as the Claude layout.
 *
 * @param {string} sessionId
 * @param {string} transcript
 * @param {string} sidecar
 * @param {{ found: { sessionId: string, transcript: string, sidecarDir: string | null }[],
 *   unreadable: { sessionId: string, path: string, reason: string }[] }} out
 * @param {{ path: string, reason: string } | null} blocked
 * @returns {{ matched: boolean, blocked: { path: string, reason: string } | null }}
 */
function tryTranscript(sessionId, transcript, sidecar, out, blocked) {
  try {
    if (!fs.statSync(transcript).isFile()) return { matched: false, blocked };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // Ordinary: this id's transcript is simply not in this project.
    } else if (!blocked) {
      // Blocked, not absent — keep the first such error for this id.
      // `err.message` already leads with `err.code`, so do not prefix again.
      blocked = {
        path: transcript,
        reason: err?.message || `${err?.code ?? 'error'}: ${err}`,
      };
    }
    return { matched: false, blocked };
  }

  let sidecarDir = null;
  try {
    const stat = fs.statSync(sidecar);
    if (stat.isDirectory()) {
      sidecarDir = sidecar;
    } else {
      // Present and not a directory — distinct from "dispatched nothing".
      out.unreadable.push({
        sessionId,
        path: sidecar,
        reason: 'exists and is not a directory',
      });
    }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // Ordinary: pruned transcript or a session that dispatched no subagents.
    } else {
      out.unreadable.push({
        sessionId,
        path: sidecar,
        reason: err?.message || `${err?.code ?? 'error'}: ${err}`,
      });
    }
  }
  out.found.push({ sessionId, transcript, sidecarDir });
  return { matched: true, blocked };
}

/**
 * Locate the transcript on disk for each host session id.
 *
 * Returns two lists rather than one: `found` for ids whose transcript was
 * located, and `unreadable` for ids that hit a real error rather than a
 * simple absence. Both the transcript stat and the sidecar stat apply the
 * same rule: `ENOENT` is ordinary — the id's transcript, or its sidecar, is
 * simply not there — and every other error (EACCES, a non-directory
 * ancestor, ...) is blocked and lands in `unreadable` carrying that error's
 * own code and message. An id with no transcript anywhere, and no error
 * anywhere, is omitted from both lists — a pruned or foreign session is a
 * normal condition, not an error.
 *
 * Blocked project directories never cause over-reporting: an id found in one
 * project directory is never marked unreadable because a *different* project
 * directory was blocked while searching for it — found-elsewhere always wins,
 * and that scoping is per id, never shared across the ids in one call.
 *
 * An id lands in both lists at once when its sidecar is unreadable: the
 * transcript was still located (`fs.statSync` on it succeeded — this module
 * never reads file contents, so "located" is the most that fact ever claims),
 * and the entry still goes into `found`, while `unreadable` carries the fact
 * that the sidecar could not be trusted. Each caller decides which fact
 * governs its own answer — `reviewEvidence` treats the second as
 * disqualifying, a plain token-count caller might not.
 *
 * Claude's `~/.claude/projects` tree is searched first. Ids still unmatched
 * are then sought under Cursor's agent-transcripts layout
 * (`…/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`). A Claude hit
 * always wins when both hosts have the same id.
 *
 * @param {string[]} sessionIds
 * @param {{ configDir?: string, cursorProjectsDir?: string, homedir?: () => string,
 *   env?: Record<string, string | undefined> }} [opts]
 * @returns {{ found: { sessionId: string, transcript: string, sidecarDir: string | null }[],
 *   unreadable: { sessionId: string, path: string, reason: string }[] }}
 */
export function findTranscripts(sessionIds, opts = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(sessionIds) ? sessionIds : []).filter(
        (id) => typeof id === 'string' && id,
      ),
    ),
  ];
  if (ids.length === 0) return { found: [], unreadable: [] };

  /** @type {{ sessionId: string, transcript: string, sidecarDir: string | null }[]} */
  const found = [];
  /** @type {{ sessionId: string, path: string, reason: string }[]} */
  const unreadable = [];
  const out = { found, unreadable };

  /**
   * @param {string} projectsDir
   * @param {string[]} projects
   * @param {(projectsDir: string, project: string, sessionId: string) =>
   *   { transcript: string, sidecar: string }} pathsFor
   * @param {Set<string>} pending
   * @param {Map<string, { path: string, reason: string }>} blockedById
   */
  function scanHost(projectsDir, projects, pathsFor, pending, blockedById) {
    for (const sessionId of [...pending]) {
      /** @type {{ path: string, reason: string } | null} */
      let blocked = blockedById.get(sessionId) ?? null;
      let matched = false;
      for (const project of projects) {
        const { transcript, sidecar } = pathsFor(projectsDir, project, sessionId);
        const result = tryTranscript(sessionId, transcript, sidecar, out, blocked);
        blocked = result.blocked;
        if (result.matched) {
          matched = true;
          pending.delete(sessionId);
          blockedById.delete(sessionId);
          break;
        }
      }
      if (!matched && blocked) blockedById.set(sessionId, blocked);
    }
  }

  /** @type {Set<string>} */
  const pending = new Set(ids);
  /** @type {Map<string, { path: string, reason: string }>} */
  const blockedById = new Map();

  const claudeProjectsDir = path.join(resolveConfigDir(opts ?? {}), 'projects');
  scanHost(
    claudeProjectsDir,
    listProjectDirs(claudeProjectsDir) ?? [],
    (dir, project, sessionId) => ({
      transcript: path.join(dir, project, `${sessionId}.jsonl`),
      sidecar: path.join(dir, project, sessionId, 'subagents'),
    }),
    pending,
    blockedById,
  );

  if (pending.size > 0) {
    const cursorProjectsDir = resolveCursorProjectsDir(opts ?? {});
    scanHost(
      cursorProjectsDir,
      listProjectDirs(cursorProjectsDir) ?? [],
      (dir, project, sessionId) => {
        const base = path.join(dir, project, 'agent-transcripts', sessionId);
        return {
          transcript: path.join(base, `${sessionId}.jsonl`),
          sidecar: path.join(base, 'subagents'),
        };
      },
      pending,
      blockedById,
    );
  }

  // Promote per-id blocks only for ids still unresolved after every host.
  for (const sessionId of pending) {
    const blocked = blockedById.get(sessionId);
    if (blocked) {
      unreadable.push({ sessionId, path: blocked.path, reason: blocked.reason });
    }
  }

  return { found, unreadable };
}
