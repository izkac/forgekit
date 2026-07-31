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
 * `findTranscripts` globs `projects/*` rather than reconstructing the munged
 * directory name: that munging rule is undocumented, and host session ids are
 * unique anyway, so a scan is both exact and immune to the rule changing.
 * Cursor transcript harvest is not implemented yet — binding still records the
 * id for later adapters.
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
 * @param {string[]} sessionIds
 * @param {{ configDir?: string, homedir?: () => string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ found: { sessionId: string, transcript: string, sidecarDir: string | null }[],
 *   unreadable: { sessionId: string, path: string, reason: string }[] }}
 */
export function findTranscripts(sessionIds, opts = {}) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(
    (id) => typeof id === 'string' && id,
  );
  if (ids.length === 0) return { found: [], unreadable: [] };

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
    return { found: [], unreadable: [] }; // no projects dir, or it is unreadable — advisory
  }

  /** @type {{ sessionId: string, transcript: string, sidecarDir: string | null }[]} */
  const found = [];
  /** @type {{ sessionId: string, path: string, reason: string }[]} */
  const unreadable = [];
  for (const sessionId of ids) {
    // Remembered, not acted on: an id blocked in one project directory may
    // still resolve in another, and found-elsewhere must win. Promoted to
    // `unreadable` only if the inner loop finishes without a match.
    /** @type {{ path: string, reason: string } | null} */
    let blocked = null;
    let matched = false;
    for (const project of projects) {
      const transcript = path.join(projectsDir, project, `${sessionId}.jsonl`);
      try {
        if (!fs.statSync(transcript).isFile()) continue;
      } catch (err) {
        if (err?.code === 'ENOENT') {
          // Ordinary: this id's transcript is simply not in this project
          // directory — overwhelmingly the common case of this scan.
        } else if (!blocked) {
          // Blocked, not absent — keep the first such error for this id; one
          // entry is enough, and the first is as informative as any other.
          // `err.message` already leads with `err.code` (Node's own stat
          // errors read "EACCES: permission denied, ..."), so this must not
          // prefix the code again — that would render "EACCES: EACCES: ...".
          blocked = {
            path: transcript,
            reason: err?.message || `${err?.code ?? 'error'}: ${err}`,
          };
        }
        continue;
      }
      const sidecar = path.join(projectsDir, project, sessionId, 'subagents');
      let sidecarDir = null;
      try {
        const stat = fs.statSync(sidecar);
        if (stat.isDirectory()) {
          sidecarDir = sidecar;
        } else {
          // Present and not a directory. Collapsing this to `null` alone would
          // be byte-identical to "dispatched nothing" — the same collapse this
          // module's own comments warn against elsewhere in the codebase.
          // The path itself is not repeated here: `review-evidence.mjs`'s
          // refusal message already prints it alongside this reason as
          // `(<path>)`, so restating it here would say it twice in one line.
          unreadable.push({ sessionId, path: sidecar, reason: 'exists and is not a directory' });
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          // Ordinary: a pruned transcript or a session that dispatched no
          // subagents looks exactly like this, and both are normal.
        } else {
          // Blocked, not absent — EACCES, a non-directory ancestor, ... The
          // error's own code and message are the honest content; nothing here
          // knows better than the error itself what went wrong. `err.message`
          // already leads with `err.code`, so this must not prefix it again.
          unreadable.push({
            sessionId,
            path: sidecar,
            reason: err?.message || `${err?.code ?? 'error'}: ${err}`,
          });
        }
      }
      found.push({ sessionId, transcript, sidecarDir });
      matched = true;
      break; // ids are unique; first hit wins
    }
    // Promotion happens here, once per id, after every project directory has
    // had its chance: found-elsewhere wins over any blocked directory seen
    // along the way, and only an id resolved nowhere carries its blocked
    // reason forward.
    if (!matched && blocked) {
      unreadable.push({ sessionId, path: blocked.path, reason: blocked.reason });
    }
  }
  return { found, unreadable };
}
