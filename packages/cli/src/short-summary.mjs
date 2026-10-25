/**
 * The `--brief` output of `forge status` and `forge phase`: the handful of
 * facts a coordinator actually reads, instead of the full JSON object.
 *
 * Both commands build the same lines from the same inputs so the two cannot
 * drift. The default (no flag) output of each command is untouched — existing
 * scripts and tests parse it.
 */

/**
 * @param {{ health: { state?: string } | null | undefined,
 *   session: Record<string, any>,
 *   dispatches: { line: string, warning: string | null },
 *   pace?: string | null,
 *   ambiguity?: { candidates?: unknown[] } | null }} facts `ambiguity` is `forge status`'s
 *   `sessionAmbiguity`: several sessions are open and `.forge/active.json` picked this one
 * @returns {string} newline-terminated; the warning line is present only when over budget
 */
export function renderShortSummary({ health, session, dispatches, pace, ambiguity }) {
  const lines = [
    `health: ${health?.state ?? '?'}`,
    `phase: ${session.phase ?? '?'}`,
    `tasks: ${session.tasksComplete ?? 0}/${session.tasksTotal ?? 0}`,
    `pace: ${pace ?? session.resolvedPace ?? session.pace ?? '?'}`,
    dispatches.line,
  ];
  if (dispatches.warning) lines.push(dispatches.warning);
  if (ambiguity) {
    const open = ambiguity.candidates?.length ?? 0;
    lines.push(`[forge] picked 1 of ${open} open sessions (from .forge/active.json) — pass --session <id> to choose`);
  }
  return `${lines.join('\n')}\n`;
}
