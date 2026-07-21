# Operator brief — `brief.html`

Every tracked change (openspec or specs engine) ends its plan phase with an
**operator brief**: one self-contained HTML file at
`<changeDir>/brief.html` that a human can read in two minutes and understand
*what will be built* — without reading proposal.md, design.md, or tasks.md.

The plan-approval checkpoint is only as strong as the operator's comprehension.
The specs are written for agents; the brief is the translation for the human
who approves them. `forge phase implement` **refuses** while the brief is
missing, unstamped, or stale.

## Who writes it

You (the agent), at the end of the plan phase — after the specs are final,
before `forge phase implement`. The CLI never generates prose; it only stamps
freshness and opens the file.

## Workflow

```bash
# 1. specs are final (proposal.md / design.md / tasks.md)
# 2. write <changeDir>/brief.html   (structure below)
forge brief stamp        # records specs hash — tell the operator where the brief is
                         # (it is NOT auto-opened; they can run `forge brief open`)
forge phase implement --tasks-total <N>   # hard-gated on a fresh stamped brief
```

If any spec file changes later, the brief goes **stale** — the gate cannot
tell meaning changes from typo fixes, so it flags both. Triage cheaply: if the
edit doesn't change what the operator approved (typo, task renumber,
formatting), just re-run `forge brief stamp` — no rewrite. If it does, update
the affected sections first, then stamp. `forge brief check` reports status.
Genuine edge case (operator explicitly waives it):
`forge phase implement --allow-incomplete "<reason>"`.

## Writing rules

Audience: a smart human who has NOT read the specs and doesn't want to.
Plain language. No spec-speak, no requirement IDs, no file paths in headings.
If a sentence would not make sense to a project stakeholder outside this
session, rewrite it.

Structure (sections, in order — skip a section only when truly empty):

1. **TL;DR** — 2-3 sentences: what will exist after this change that doesn't
   today, and why it's worth doing.
2. **What you'll get** — the observable outcomes, bulleted. Behavior, not
   implementation ("you can send a message to any session from one terminal",
   not "a registry module under lib/").
3. **How it works** — the shape of the solution in one short narrative plus a
   **mermaid diagram** where a picture beats prose (flow, sequence, or state —
   whichever fits; skip the diagram for trivial changes rather than forcing one).
4. **What changes for you** — new commands/screens/steps the operator will
   use; anything that behaves differently than before.
5. **Risks and open questions** — honest, short. What could go wrong, what was
   deliberately deferred, what the operator should keep an eye on.
6. **Out of scope** — what this change deliberately does NOT do.
7. **Work overview** — task groups from tasks.md compressed to one line each,
   with rough size (n tasks). Not the full task list.

## File rules

- One file, self-contained: inline CSS, no build step, no local assets.
- Mermaid via CDN is fine (`<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js">`
  + `mermaid.initialize({ startOnLoad: true })`; diagrams in `<pre class="mermaid">` blocks).
  Trade-off accepted: diagrams need internet to render; the text must stand on
  its own without them.
- Readable defaults: max-width ~48rem/prose, system font stack, dark-on-light.
  Keep styling minimal — this is a memo, not a product page.
- Do not remove the `<!-- forge-brief-specs-hash:… -->` comment `forge brief
  stamp` inserts; re-stamping updates it.

## Archive

`brief.html` lives in the change dir, so it archives with the change
(`changes/archive/…`) and remains the human-readable record of what was
approved — useful input for archive→ADR.
