# Design — opt-in Forge invocation

## Context

Three independent on-ramps start Forge today: skill self-invocation, always-on thin rules, and Claude’s per-prompt triage hook. Removing only the hook would leave Cursor/Codex auto-starting from rules. Removing only the rules would leave Claude nagging.

## Decisions

- **Decision: invoke = slash family OR “use Forge” phrasing.**
  - Alternatives: slash-only (rejected — operator asked for natural language); any substantial work (status quo).
  - Matcher: `/^\s*\/forge(?::|\s|$)/i` (existing) plus `/\b(?:use(?:\s+the)?|using)\s+forge\b/i`. Does not match `forgekit` (`forge` is not a whole word there).
  - Shared by `isForgeInvocation` (CLI) and the prompt hook (duplicated: project hooks cannot import CLI internals).

- **Decision: retire `forge-triage-hook.mjs` rather than invert it.**
  - The prompt hook already injects session context on invoke. Keeping a silent/inverted triage hook is a duplicate.

- **Decision: init may remove this one forge-owned hook.**
  - Alternatives: leave leftovers (doctor then fails if the file stays unwired; if wired, auto-triage continues); ask the operator to edit settings by hand.
  - Exception to “never remove existing hook entries”: basename exactly `forge-triage-hook.mjs`. Wrappers such as `my-forge-triage-hook.mjs` are left alone.
  - Strip from `.claude/settings.json` and `.claude/settings.local.json` when parseable; delete `.claude/hooks/forge-triage-hook.mjs`. Always refresh `forge-hooks.snippet.json` so a stale snippet cannot reintroduce the hook on a later manual merge.

- **Decision: keep `forge triage` CLI.** Manual/tests still use it. Nothing auto-calls it after the hook is gone.

- **Decision: in-session continuation.** Not “triage every request”. An active session is already invoked.

## Risks / Trade-offs

- Already-wired projects keep auto-triaging until `forge init` / `forge doctor --install` plus skill reinstall.
- Eval forge-arm preambles that say “Use the installed Forge CLI” remain an explicit invoke.
- Codex has no slash commands; “use Forge” is the invoke.
