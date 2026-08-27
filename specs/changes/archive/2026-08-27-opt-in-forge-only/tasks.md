# Tasks

## 1. Invocation detection

- [x] 1.1 `isForgeInvocation` matches `/forge`, `/forge:*`, “use Forge”, “using Forge”, “use the Forge …”; does not match “Add login”, “What is forge?”, “use forgekit”. Tests in `packages/cli/src/triage-prompt.test.mjs`.
- [x] 1.2 Prompt hook uses the same matcher (slash or “use Forge”) and stays silent on a plain work request. Tests in `packages/cli/src/forge-prompt-hook.test.mjs`. Drop triage-hook cases from that file.

## 2. Retire auto-triage hook

- [x] 2.1 `stripRetiredHookCommands` removes `forge-triage-hook.mjs` leaves from a settings document without touching user hooks or wrapper names. Tests in `packages/cli/src/hooks.test.mjs`.
- [x] 2.2 `forge init --claude` / `ensureClaudeHookHints` does not ship or wire the triage hook; on a leftover file + settings entry it deletes the file and strips wiring (settings.json and settings.local.json). Snippet on disk is refreshed. Tests in `packages/cli/src/init.test.mjs`.
- [x] 2.3 Delete `templates/project/claude/hooks/forge-triage-hook.mjs` and this repo’s `.claude/hooks/forge-triage-hook.mjs`. Update `.claude/settings.json`, `.claude/forge-hooks.snippet.json`, and `init.mjs` snippet. Partial-wiring merge test uses a synthetic two-command group (UserPromptSubmit will have one command).

## 3. Agent instructions and operator docs

- [x] 3.1 Forge skill: `disable-model-invocation: true`; Step 0 runs only after invoke; triage remains first pipeline step. `references/substantial-work.md` enter-conditions are invoke-only. Thin-rule templates + this repo’s copies invert the default. `skills/forge/docs/forge.md` agent-surfaces table. Verify: thin-rule test plus a pin that skill/rules do not say “triage before implementation” as the default.
- [x] 3.2 Operator docs: `docs/day-to-day.md` starting-work section; slash-command templates keep triage as step 1; CHANGELOG. Verify by reading the files.

## 4. Follow-up: invoke phrasing + existing-change routing

- [x] 4.1 Broaden `isForgeInvocation` (CLI + prompt hook, kept in sync) to any ask-for-Forge-by-name phrasing: “with Forge”, “do forge work”, “run the forge workflow”, “start a forge session”. Tests in `triage-prompt.test.mjs`.
- [x] 4.2 Skill Step 0, `substantial-work.md`, and thin rules: invoked work over an already-proposed change routes to the `/forge:apply` flow (session + implement phase + subagents), never inline implementation.
- [x] 4.3 `/forge` command templates (cursor + claude) route existing changes themselves — step 2 switches to the apply flow with `forge phase implement`; pinned in `init.test.mjs`. This was the actual reported failure: `/forge` over an existing OpenSpec change implemented inline with no session.
