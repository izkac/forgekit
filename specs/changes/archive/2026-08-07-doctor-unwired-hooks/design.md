# Design — doctor-unwired-hooks

## Context

Doctor today is plan-engine readiness only (`checks.project`, `checks.cli`).
The canonical Claude hook wiring lives in `init.mjs` as the snippet written to
`.claude/forge-hooks.snippet.json`; Cursor wiring goes into
`.cursor/hooks.json` (init writes that one itself).

## Decisions

1. **Detection contract keys off files on disk, not a hardcoded hook list.**
   Any `forge-*.mjs` in the surface's hooks dir must be referenced in the
   surface's wiring file(s). Future hooks are covered automatically; renamed
   hooks cannot drift out of the check.
   - Claude: hooks dir `.claude/hooks/`, wiring `.claude/settings.json` OR
     `.claude/settings.local.json` (either counts — local wiring is valid).
   - Cursor: hooks dir `.cursor/hooks/`, wiring `.cursor/hooks.json`.
   - "Referenced" = some hook `command` string in the wiring JSON contains the
     hook file's basename. Commands are walked structurally (every `command`
     property under the `hooks` config), not substring-matched against the
     whole file, so a hook named in a comment-like field cannot false-pass.
2. **Absence is not failure.** No hooks dir for a surface → surface skipped
   (init decides which surfaces a project wires). No surfaces at all →
   `checks.hooks.ok = true, skipped = true`.
3. **Unparseable wiring file while forge hooks exist on disk → failure**, with
   the parse problem in the message: at runtime that state behaves exactly
   like unwired. Nuance (implemented, per the task brief): the unparseable
   file contributes no references, but if the surface's *other* wiring file
   (e.g. `settings.local.json`) parses and references every forge hook, the
   hooks are wired and the surface passes — matching how the host actually
   loads hooks. `wiringError` still records the parse problem.
   Missing wiring file while hooks exist → failure (the volo-adjacent case of
   never creating settings.json at all).
4. **Doctor exit code:** unwired hooks fail doctor (exit 1); `--warn-only`
   still exits 0. `runDoctorChecks().ok` becomes
   `project.ok && cli.ok && hooks.ok`.
5. **Report shape (additive):**

   ```
   checks.hooks = {
     id: 'hook-wiring',
     ok: boolean,
     skipped?: true,
     surfaces: [{
       surface: 'claude' | 'cursor',
       hooksDir, wiringPaths: string[],
       present: string[], unwired: string[],
       wiringError: string | null,
       ok: boolean,
     }],
     message: string,
   }
   ```

## Risks

- Projects with intentionally-unwired hook files start failing doctor. Escape
  hatch is deleting the stray file or wiring it; acceptable — the state is
  exactly what the check exists to surface.
- `settings.json` may use `$CLAUDE_PROJECT_DIR` or `${CLAUDE_PROJECT_DIR}`
  forms; basename matching is form-agnostic by construction.
