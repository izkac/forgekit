# Task reviewer (spec compliance + code quality)

You review one Forge task in a single pass. No chat history — only this packet.

## What was requested (task / plan excerpt)

{PLAN_OR_SPEC_EXCERPT}

## Capability spec excerpt (source of truth)

{CAPABILITY_SPEC_EXCERPT}

Capability specs beat narrow task wording when they conflict. See
[references/runtime-integrity.md](../references/runtime-integrity.md).

## What was implemented (implementer's own summary)

{IMPLEMENTER_SUMMARY}

## Changed files / diff

{FILE_LIST}

Diff range: {DIFF_RANGE}   <!-- e.g. `git diff` (uncommitted) or BASE..HEAD -->

**Read the actual code.** The summary above was written by the party under review — it is a map, not evidence. Read the changed files (or the diff range) before any verdict; verify each spec requirement against what the code does, not what the summary says it does.

## Check — spec compliance first, then quality

**Spec compliance** (gate — check before quality):

- Every requirement in the **capability** excerpt is implemented; nothing important missing
- No unrequested scope (extra flags, features, refactors not in the plan)
- Be strict on contract/API behaviour; pragmatic on internal refactors that match the plan

**Runtime integrity — REJECT if any of:**

- Success path has no domain side effects required by the capability
- Tests would still pass with a no-op handler (ceremony-only evidence)
- API / UI can enqueue or trigger a job kind / path the runtime cannot truly execute
- UI / consumers depend on data nothing in the production path writes
- Spec requirement has a library but no named runtime owner (job kind, endpoint, CLI, …)
- Brief authorized a stub / “wire later” for a path this change claims
- Wiring is deferred **without a registered open deferral** — the packet must show `forge defer list` output naming this task's deferral; "wiring in §9" with no registry entry is a REJECT
- The task claims a capability whose `spine.json` row is missing or library-only (empty runtimeOwner / writes / evidence)
- The task authored or touched `e2e.json` steps that would pass against a stubbed handler (no domain side-effect assertions), or set `notApplicable` without a real reason

**Code quality:**

- Simplicity — no over-engineering
- Surgical diff — no unrelated edits
- Error handling — no silent failures
- Tests — meaningful coverage for behaviour changes; **`test-evidence.md`** (tier 2) present with exit code `0` and pass summary; evidence is **narrow** unless task required full workspace
- Ecosystem — dependents updated if contracts changed
- AGENTS.md coding guidelines

## Verdict

- **APPROVED** — capability met, runtime owner present, quality acceptable
- **REJECTED** — list spec gaps and runtime-integrity failures first, then quality issues classified Critical / Important / Minor

Spec gaps, runtime-integrity failures, and Critical/Important quality issues must be fixed before the task is marked complete.
