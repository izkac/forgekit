# Design — init preserves recorded config

## The decision: one precedence order, applied to both choices

The fix is not new behavior; it is inserting one missing source into an existing
precedence chain, in two places, consistently.

**Plan engine** (`resolveInitPlanEngine`). Today:

```
--no-openspec        → specs
--openspec           → openspec
configured (os dir)  → openspec
user default         → specs | openspec
prompt / non-TTY     → specs
```

After:

```
--no-openspec              → specs
--openspec                 → openspec
recorded plan.engine       → that engine   ← inserted
configured (os dir)        → openspec
user default               → specs | openspec
prompt / non-TTY           → specs
```

**ADR** (the block at init.mjs ~865). Today, when `opts.adr === null`: TTY prompt
(default from `user.adr`), else `user.adr.enabled === true → true`, else false.
After: if the project recorded `adr.enabled`, use it; otherwise the existing
user/prompt path unchanged.

## Why recorded config outranks the on-disk `configured` signal, but not a flag

- **A flag is an explicit request to change**, so it must win. `--openspec` on a
  recorded-specs project still converts it — that is the sanctioned way to switch,
  and it is verified to work today.
- **Recorded config is the project's settled decision**, so it outranks the user's
  machine default and the incidental `configured` check. A project that recorded
  `specs` but happens to have a stray `openspec/` dir should stay specs; the
  recorded value is the intent, the directory is a side effect.
- **The `configured` OpenSpec-dir check stays** below recorded config, for the
  genuine first-run case: a project with an OpenSpec setup but no `.forge` config
  yet (e.g. adopted OpenSpec before Forge) still resolves to openspec.

## Reading the existing config

`resolveProjectPlanEngine(cwd, { useUserDefault: false })` already returns the
recorded engine and dir, or the `{engine:'openspec', dir:'openspec'}` last resort
when nothing is recorded. That last resort is the trap: it means "not recorded",
not "recorded openspec". So the resolver cannot be used raw — the code must read
`loadProjectConfig(cwd)` and check whether `plan.engine` / `adr.enabled` are
**actually present** in the file, treating absent as "fall through" and present
as "honor". `plan.dir` is read from the same recorded config so it is preserved
rather than defaulted.

## Alternatives considered

- **Refuse to re-init a configured project** — too blunt; re-init is a documented,
  wanted operation for picking up new command wording. The problem is not that it
  runs, but that it changes settled choices it was not asked to change.
- **Prompt "keep existing specs engine?"** — a prompt cannot help the non-TTY path,
  which is where this was reproduced (agents, CI). The default itself has to be
  correct without a human present.

## Risk

Low. No schema change; explicit flags are untouched and already tested. The
narrow risk is misreading "absent" as "present" (or the reverse) and either
failing to honor a real recorded value or inventing one — so the tests assert
both a recorded-value project (honored) and a no-config project (unchanged
first-run behavior).
