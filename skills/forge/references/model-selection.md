# Model selection — hard rules

**Read this before every Task / Agent / subagent dispatch.** Billing mistakes
here spend the user's money. The resolver exists so you never invent a slug.

## The only legal sequence

```bash
forge resolve-model --tier <fast|standard|capable>
```

Then honor the JSON **literally**:

| Field | What you do |
| ----- | ----------- |
| `omitModel: true` | **Omit** the host `model` / `Model` parameter entirely. Do not pass `null`, `""`, `"auto"`, `"default"`, or any slug. |
| `omitModel: false` and `model: "<slug>"` | Pass **exactly** that string as `model`. No aliases, no “close enough”, no upgrade. |
| `billing: "included"` | Stay on the subscription / first-party pool. |
| `billing: "metered"` | API / paid lane — only when the user (or `forge models metered`) already chose it. |

Re-resolve before **every** dispatch, including retries and fallbacks after a
failure. A previous turn’s slug is not a cache you may reuse.

## What you must never do

These are all the same mistake: **overriding the resolver**.

1. **Picking a slug from the host’s “available models” list** (Cursor Task
   `model` enum, Claude model picker, docs examples, memory of “what we used
   last time”). That list is not permission to choose — it is inventory the
   host exposes. Your permission comes only from `forge resolve-model`.
2. **Passing a model when `omitModel` is true.** On Cursor, `included` often
   resolves to `omitModel: true` so the subagent **inherits** the parent
   subscription session. Passing e.g. `claude-sonnet-5-thinking-high` or any
   other named slug **forces a different (often metered) model** and can bill
   the user. That is a serious transgression.
3. **Hand-picking “a capable model”** because the task is hard, the review is
   final, or the label says `capable`. Capability is the **`--tier`** you pass
   to the resolver — not a license to type a product model id.
4. **Inventing or “remembering” API slugs** (`claude-…`, `gpt-…`, `composer-…`,
   etc.) when the resolver returned `model: null`.
5. **Switching to `metered` / API models** because a dispatch failed, was slow,
   or was denied — unless the **user explicitly** asked for metered/API (or
   already ran `forge models metered`). Escalate **tier** (`fast` → `standard`
   → `capable`) within `included` instead, then re-resolve.
6. **Typing a `forge-review …` label by hand** and also inventing a reviewer
   model — label from `forge review-label`; model from `forge resolve-model`.

## Why `omitModel: true` exists

Defaults (`packages/cli/src/models.defaults.json`) keep Cursor on **inherit**:
the subagent uses the same included pool as the parent chat. The only way to
honor that is to leave `model` unset. Any explicit slug is an override.

Claude Code projects may additionally run `forge enforce-model` on PreToolUse.
A rewrite is project policy; a denial means resolve again and dispatch what the
resolver returns — never retry the same hand-picked slug.

## Capability tier (what you *are* allowed to choose)

You choose only the **tier** argument to the resolver:

| Tier | Typical use |
| ---- | ----------- |
| `fast` | Mechanical 1–2 file tasks, complete spec |
| `standard` | Multi-file integration, pattern matching |
| `capable` | Final review, design judgment, broad reading; money/auth floor reviews |

Then **stop choosing**. Run the command; follow the JSON.

## Checklist (copy into your head before Task)

- [ ] Ran `forge resolve-model --tier …` **for this** dispatch
- [ ] If `omitModel: true` → Task call has **no** `model` field
- [ ] If `omitModel: false` → `model` equals resolver `model` byte-for-byte
- [ ] Not using a slug from the host model list / memory / docs
- [ ] Not flipping to metered unless the user asked

If you catch yourself about to pass a model slug you did not just receive from
the resolver: **delete it and re-resolve.**
