# Align Subagent TDD Evidence

## Why

F106 identified a mismatch between Forge's executed RED→GREEN gate and its subagent workflow: the gate is sound and already accepts explicit session targeting, but implementer/reviewer packets do not require that target, reviewers describe plain transcribed evidence as acceptable, and `forge evidence` creates an artifact that a flagged task cannot use. Failure arrives only at `phase done`.

## What Changes

- Make implementer/reviewer packets name the session, task, executed ledger, and exact explicit-session TDD commands.
- Fail fast when plain evidence would be the only evidence for a flagged task, while retaining supplemental evidence and `--no-tdd` compatibility.
- Print a durable ledger receipt after each executed TDD stamp.

## Capabilities

- `tdd-evidence`: Align subagent orchestration with the existing executed-evidence gate without weakening pairing semantics.
