/**
 * Shared notion of "is this forge hook referenced", used by both
 * `doctor.mjs` (`checkHookWiring` — is a hook file on disk wired into the
 * host surface?) and `init.mjs` (`mergeHooksIntoSettings` — is this snippet
 * command already present, so it must not be re-appended?).
 *
 * The two used to carry independent copies of the walker and a bare
 * substring match. They drifted apart once (settings.local.json was folded
 * into doctor's notion of "wired" but never into init's merge — a project
 * wired only via the local file would silently get every hook re-appended
 * by `forge init`); a single shared module makes that class of drift
 * structurally impossible, not just enforced by a comment.
 */

/**
 * Recursively collect every string value of a `command` key found anywhere
 * under `node` (expected to be a surface's `hooks` subtree, or a single
 * matcher group within one).
 * @param {unknown} node
 * @param {Set<string>} out
 */
export function collectHookCommands(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectHookCommands(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'command' && typeof value === 'string') {
        out.add(value);
      } else {
        collectHookCommands(value, out);
      }
    }
  }
}

/**
 * Best-effort basename of the hook script a `command` string invokes, e.g.
 * `node "${CLAUDE_PROJECT_DIR}/.claude/hooks/forge-model-hook.mjs"` ->
 * `forge-model-hook.mjs`.
 * @param {unknown} command
 * @returns {string | null}
 */
export function commandBasename(command) {
  if (typeof command !== 'string') return null;
  const token = command.trim().split(/\s+/).pop() ?? '';
  const stripped = token.replace(/^["']|["']$/g, '');
  if (!stripped) return null;
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Whether `basename` is referenced by any string in `commands`, matching at
 * a path/quote/whitespace boundary rather than a bare substring test. A
 * plain `.includes()` lets a wrapper script mask the real hook: a project
 * hook named `my-forge-session-start.mjs` would make a bare substring check
 * believe `forge-session-start.mjs` is wired, when nothing actually runs it.
 * @param {string} basename
 * @param {Iterable<string>} commands
 * @returns {boolean}
 */
export function isCommandReferenced(basename, commands) {
  if (!basename) return false;
  const escaped = basename.replace(REGEX_SPECIAL, '\\$&');
  const boundary = new RegExp(`(?:^|[\\\\/"'\\s])${escaped}(?:["'\\s]|$)`);
  for (const command of commands) {
    if (typeof command === 'string' && boundary.test(command)) return true;
  }
  return false;
}
