---
name: brainstorming
description: Forge — brainstorm before plan. Internal skill; read via forge orchestrator.
---

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then interview the user in frontier rounds to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Spike or design?

Before any interviewing, classify the request. If the core open question is
*feasibility* ("can X work at all?", "is this library fast enough?"), it is a
**spike**: agree the question and a time box with the user, investigate with
throwaway code clearly labeled as such, and report a recommendation. A spike
produces no spec and no design doc, and approval of a spike (or its
recommendation) is NEVER approval to implement — follow-up work starts a fresh
brainstorm with the spike's findings as context. Everything else takes the
normal flow below.

## Checklist

A spike-classified request skips this checklist and follows "Spike or
design?" instead.

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits
2. **Interview in frontier rounds** — ask every question whose prerequisites are settled (the whole frontier in each round), numbered with a recommended answer (genuinely visual questions use `design/<surface>/` mockups — see Visual questions below); facts go to the codebase or an exploration subagent, never to the user; a question only an absent stakeholder can answer gets a questionnaire hand-off instead of stalling the round (see below)
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Write design doc** — save to `.forge/sessions/<session-id>/brainstorm/notes.md` and `decisions.md`, including the `## Assumptions` section from the interview ledger
6. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope, silent assumptions (see below)
7. **User reviews written spec** — ask user to review the spec file before proceeding
8. **OpenSpec propose** — invoke `openspec-propose` or `/opsx:propose <prefix>-<slug>` per forge plan-routing (no plan-mode prompt)

## Process Flow

Explore context → interview in frontier rounds (facts resolved directly or via exploration subagent; decisions batched per round until the frontier and ledger are empty) → propose 2-3 approaches → present design sections (revise until approved) → write design doc with Assumptions → spec self-review (fix inline) → user reviews spec (revise until approved) → **OpenSpec propose**.

**The terminal state is OpenSpec propose.** Do NOT invoke frontend-design, mcp-builder, or any other implementation skill. Run `/opsx:propose` (or `openspec-propose`) — do not implement until OpenSpec artefacts are approved.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, run the frontier-round interview below to refine the idea
- Focus on understanding: purpose, constraints, success criteria

**Interviewing in frontier rounds:**

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one. Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them.

Use this round format:

```
❓ **Q1** - **<question title>**: <question body, may include multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: …

➡️ <your recommended answer>
```

- **Facts vs decisions.** Finding facts is your job, never the user's. A frontier question answerable from the codebase, docs, or environment gets looked up directly or dispatched to an exploration subagent, non-blocking: only questions downstream of that fact wait for it — the rest of the frontier goes to the user now. Only genuine decisions go to the user.
- **Fast path.** Every question carries a recommended answer with a one-line why. In the first round, tell the user once that they may reply "all recommended" to accept the whole round, or answer selectively (e.g. "Q1: b, rest recommended"). Prefer multiple choice where natural.
- **Ledger + termination.** Maintain an open-questions-and-assumptions ledger in `.forge/sessions/<session-id>/brainstorm/notes.md` as you interview. The interview ends only when the frontier is empty AND every ledger entry is either answered or promoted to an explicit assumption. The design doc's `## Assumptions` section lists every default you adopted without asking, and it is presented for user review along with the rest of the design.
- **Questionnaire escape hatch.** When a frontier question can only be answered by someone not in the session (a stakeholder, another team), do not stall and do not guess: mark that branch **blocked** in the ledger, write a hand-off questionnaire to `questionnaire-<slug>.md` in the repo root (purpose and the decision riding on it; who it is for; one context paragraph; gap-targeted questions, most important first, each one idea with an answer stub beneath), tell the user its path so they can send it, and keep interviewing the rest of the frontier now. A blocked branch resolves only when answers come back, or by promotion to an explicit Assumption with the user's consent.
- **Domain pass.** When the repo has a `CONTEXT.md` glossary, challenge terms that conflict with it ("your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?") and propose precise canonical terms for fuzzy or overloaded ones ("'account' — Customer or User?"). No `CONTEXT.md` → skip silently.
- **Pace.** `brainstorm.depth: full` runs rounds until the frontier is empty; `short` caps at roughly two rounds, folding remaining open branches into recommended-answer entries in Assumptions; `minimal` runs at most one round confirming intent, and unasked branches become Assumptions.

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation:**

- Write the validated design (spec) to `.forge/sessions/<session-id>/brainstorm/notes.md`
  - (User preferences for spec location override this default)
- Use elements-of-style:writing-clearly-and-concisely skill if available
- When writing `decisions.md`, prefix an entry with `ADR-candidate:` only when it passes all three of: hard to reverse, surprising without context, the result of a real trade-off. Projects with ADRs enabled pick these up at archive time; trivially reversible choices get no prefix.
- Do not commit unless the user explicitly asks

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.
5. **Silent assumptions:** Is any default in play that is not listed under Assumptions? If so, add it.
6. **Scenario red-team:** invent 2–3 concrete edge-case scenarios that probe the design's boundaries and check the design answers each one. A scenario the design cannot answer becomes an open question to the user or an explicit Assumption — never silently dropped.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written to `<path>`. Please review before we proceed to the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

**Implementation:**

- Proceed to forge **plan phase** (OpenSpec via `/opsx:propose`)
- Do NOT invoke implement phase or write production code yet

## Key Principles

- **Whole frontier per round** - Ask every question whose prerequisites are settled, not one at a time; a question still waiting on this round's answers moves to the next round
- **Recommended answer on everything** - Every question carries a recommendation and a one-line why, so "all recommended" is always a valid reply
- **Facts never asked of the user** - Look them up or dispatch an exploration subagent; only decisions go to the user
- **Nothing silently assumed** - Every default not asked about is logged in the ledger and surfaces in the design doc's Assumptions section
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual questions

When a question is genuinely visual (mockups, wireframes, layout comparisons — not merely *about* a UI topic), use the Janus convention instead of describing designs in prose: write static HTML mockups to `design/<surface-name>/` with a picker `index.html` plus one file per variant (AGENTS.md § Design exploration artefacts), then ask the user to open them and pick. Text questions (requirements, tradeoffs, A/B/C choices) stay in the terminal.
