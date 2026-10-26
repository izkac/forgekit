## Why

Escape tracking can now tell which Forge sessions shipped a bug that a later fix commit caught, and replay verification confirms it mechanically: the fix's test fails on the old code and passes on the fix (Volo: 96 confirmed escapes across 41 sessions). The eval harness, though, only measures Forge against plain agents on synthetic tasks. A confirmed escape is a real task Forge got wrong, with a real hidden test that tells a correct solution from Forge's. A corpus of them is the honest benchmark of whether a process change catches the bugs Forge actually ships.

## What Changes

- New repo-only script `evals/harbor/export-escape-replays.mjs --project <path> [--include <file>]…`. It reads the project's confirmed escapes and writes the Harbor corpus `forgekit-escape-replays-v1`, one task per escaped session, into the gitignored `evals/harbor/local/forgekit-escape-replays-v1/`. The tasks hold the project's source, which may be private, so they never enter the forgekit repository.
- Each task:
  - Agent environment: a snapshot of the nested repository at the session's base commit (`git archive`, no `.git`, no ignored files). A Dockerfile installs dependencies and pre-fetches the MongoDB binary that `mongodb-memory-server` downloads at first use, so tests run without network.
  - Instruction: the archived change's `proposal.md` and `specs/**/spec.md`. `design.md`, `tasks.md` and the brief are Forge's own plan output, so they are left out.
  - A hidden, separate, no-network verifier. It runs the fix commits' test files with the recorded replay command and writes `reward.json` with the four binary metrics plus requirement and regression counts.
  - `solution/solve.sh`, which applies the reference: the escaped head plus the fix diffs, without the hidden test files.
- Calibration, behind the exec opt-in (`FORGEKIT_ALLOW_EXEC=1`). The hidden tests must fail on the escaped head and pass on the reference, both run in sibling replay worktrees. A session that fails calibration, cannot build its reference, has no archived spec, or has no usable base is dropped. Each drop is recorded with a reason in `export-report.json`.
- Ignored files such as `.env` are never copied by default. `--include <path>` copies a named one into the environment snapshot.
- `corpus-selection.mjs` registers `forgekit-escape-replays-v1` only when its local manifest exists. Otherwise selecting that ID fails as an unknown corpus, as before.
- Docs: `evals/README.md` gets a section on the escape-replay corpus.

Out of scope:
- Running agent trials or building Docker images. Both cost money, so the operator runs them deliberately.
- Runner-specific handling. Any escape whose test has a replay rule is exported (Volo: server Jest, client Vitest, mobile Jest). The verifier runs each hidden test with its recorded command; an escape with no rule is skipped with a reason.
- Publishing the corpus.
- Changes to the published CLI.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `evaluation-corpus`: an escape-replay corpus is exported locally from confirmed escapes, is calibrated, and keeps private source out of the repository (added requirements).
