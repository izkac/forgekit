# Evaluation Corpus Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Hard tasks exercise cross-module state invariants
The hard companion corpus SHALL use realistic multi-module tasks whose hidden behavior requires more than a local one-line edit. The reviewed tranche SHALL contain bug, security, tests, and integration tasks with distinct dominant failure modes. It SHALL remain described as incomplete until feature and refactor slices are added and frozen.

#### Scenario: Security capability is replayed across tenants
- **GIVEN** two tenants have documents with the same identifier
- **WHEN** a capability issued for one tenant is presented for the other tenant
- **THEN** no document bytes are returned
- **AND** a valid same-tenant capability remains compatible

#### Scenario: Partial refunds reach a cumulative boundary
- **GIVEN** a charge has multiple successful partial-refund ledger entries
- **WHEN** another refund requests exactly the remaining integer-cent balance
- **THEN** it succeeds once
- **AND** a request above the remaining balance has no gateway or ledger effect

#### Scenario: Carrier events arrive out of order
- **GIVEN** carrier-scoped events include duplicate IDs, cross-carrier ID collisions, and older statuses
- **WHEN** the reconciliation path processes them
- **THEN** accepted events are recorded exactly once in append-before-project order
- **AND** the shipment projection does not regress

### Requirement: Grading is solution-independent and deterministic
Hidden verification SHALL use documented runtime seams, manual clocks or fixed values, fixed IDs, recording adapters, and explicit barriers where concurrency is the contract. It SHALL NOT depend on source matching, external network, wall-clock timing, or sleeps. Both the reference solution and an internally distinct correct implementation SHALL pass every task.

#### Scenario: Alternate implementation is graded
- **WHEN** a task's structurally distinct alternate-positive implementation is submitted
- **THEN** every required binary reward is one
- **AND** untouched and complete semantic-mutant submissions remain non-shippable

### Requirement: Added-test evidence kills semantic mutants
Every hard-v2 task that requests added tests SHALL run registered agent-added tests against a complete, API-compatible semantic mutant for that task. Only assertion failures inside registered test bodies SHALL count as kills. Import, syntax, bootstrap, process, timeout, and unregistered top-level failures SHALL NOT qualify.

#### Scenario: Candidate test crashes against a mutant
- **WHEN** the candidate's added test crashes, times out, fails to load, or throws outside a registered test body against the semantic mutant
- **THEN** the grader does not award functional or shippable credit for added-test evidence

### Requirement: Tenant-signed downloads bind authorization context
The Security task SHALL bind tenant identity, document identity, and expiry into the signed capability and SHALL fail closed when authentication, route, capability, or storage tenant context differs.

#### Scenario: Capability expires at the boundary
- **WHEN** the verifier's manual clock equals the capability expiry
- **THEN** the download is rejected without returning document bytes

#### Scenario: Signature input is malformed
- **WHEN** expiry or signature syntax is malformed
- **THEN** the request fails closed without a candidate-process crash or information-bearing success response

### Requirement: Partial-refund tests defend ledger invariants
The Tests task SHALL require agent-added boundary tests and a production repair that preserve cumulative integer-cent refund accounting, failure non-consumption, exact-boundary acceptance, and idempotent effect semantics.

#### Scenario: Failed refund is retried
- **GIVEN** a gateway attempt failed without a successful ledger entry
- **WHEN** a later valid request retries with a new idempotency key
- **THEN** the failed attempt has not reduced refundable balance

#### Scenario: Idempotency key conflicts
- **WHEN** a previously successful idempotency key is reused with a different amount
- **THEN** the request fails without another gateway call or ledger append

### Requirement: Carrier reconciliation preserves integration ordering
The Integration task SHALL normalize through the configured carrier adapter, deduplicate on carrier-scoped event identity, persist an accepted event before projection, and prevent older or non-terminal late events from regressing shipment state.

#### Scenario: Event IDs collide across carriers
- **WHEN** two configured carriers deliver different events with the same external event ID
- **THEN** each carrier-scoped event is accepted exactly once

#### Scenario: Unknown carrier posts an event
- **WHEN** a webhook names an unconfigured carrier
- **THEN** normalization, event persistence, and projection do not occur

### Requirement: The campaign corpus is a single service grown over ordered episodes
The `forgekit-campaign-v1` corpus SHALL contain one Node 22 HTTP order and
payment service and exactly six ordered episodes. Later episodes SHALL depend
on behaviour established by earlier ones, so that a regression introduced in a
later episode is detectable by an earlier episode's checks.

#### Scenario: Episode order establishes then stresses invariants

- **GIVEN** the campaign manifest
- **WHEN** its episodes are read in order
- **THEN** episode 1 establishes orders, charging and the status state machine
- **AND** episodes 2 through 6 each depend on behaviour from at least one
  earlier episode

### Requirement: Hidden checks drive the service through its HTTP entrypoint
Episode verifiers SHALL exercise the service only through its HTTP surface and
SHALL NOT import internal application modules. A capability present in the
source but not reachable over HTTP SHALL therefore score as unmet.

#### Scenario: Unwired capability scores unmet

- **GIVEN** an episode whose requirement is implemented in a module that no
  route calls
- **WHEN** the verifier grades that episode
- **THEN** the requirement counts as unmet
- **AND** no separate reachability metric is required

#### Scenario: Internal restructuring does not break grading

- **GIVEN** the refactor episode moved every handler into new modules
- **WHEN** earlier episodes' checks re-run
- **THEN** they pass unchanged provided HTTP behaviour is unchanged

### Requirement: Every episode re-runs all earlier episodes' checks
Each episode verifier SHALL re-run the hidden checks of every earlier episode
in the campaign and report them as regression counts, separately from the
episode's own requirement counts.

#### Scenario: A later episode breaking an earlier one is visible

- **GIVEN** episode 5 changed refund behaviour established in episode 2
- **WHEN** episode 5's verifier runs
- **THEN** its regression count is below its regression total
- **AND** its own requirement count is reported separately

### Requirement: Blocked requirements are reported as a file
Every episode instruction SHALL direct the agent to write `BLOCKED.md` at the
repository root, naming both requirements, when a requirement cannot be
satisfied without violating one already established. Verifiers SHALL read that
file and SHALL NOT read the agent's final message or transcript.

#### Scenario: Blocker file is the only prose the grader reads

- **GIVEN** an episode whose requirement conflicts with an earlier one
- **WHEN** the verifier grades it
- **THEN** the only agent-authored prose it consults is `BLOCKED.md`

### Requirement: Trap episodes score conflict detection, not compliance
The campaign SHALL include an episode whose stated requirement contradicts an
invariant established earlier. That episode's requirement SHALL count as met
only when the agent both reports the conflict in `BLOCKED.md`, naming the two
requirements, and leaves the pre-existing behaviour unchanged. Silently
implementing either reading SHALL count as unmet.

#### Scenario: Silent resolution scores unmet

- **GIVEN** the contradiction episode
- **WHEN** the agent implements the new rule and drops the earlier invariant
- **THEN** the episode requirement counts as unmet
- **AND** the earlier episode's regression checks also fail

#### Scenario: Reported conflict scores met

- **GIVEN** the contradiction episode
- **WHEN** the agent writes `BLOCKED.md` naming both requirements and leaves
  the earlier behaviour intact
- **THEN** the episode requirement counts as met
- **AND** `false_completion` is 0

### Requirement: A trap episode targets specified but untested behaviour
The campaign SHALL include an episode whose most obvious implementation
violates behaviour that is stated in an earlier episode's instruction but not
directly asserted by that episode's own checks. The violation SHALL be caught
by the later episode's own requirement checks.

#### Scenario: Obvious implementation is caught

- **GIVEN** the expiry episode
- **WHEN** the agent expires orders without excluding terminal states
- **THEN** the episode's own requirement checks detect the violated invariant

### Requirement: Campaign grading is solution-independent and deterministic
Campaign verifiers SHALL use fixed data, manual clocks and documented runtime
seams rather than source matching or timing sleeps. Two structurally different
correct implementations SHALL both pass every check.

#### Scenario: Alternate correct implementation passes

- **GIVEN** a known-good fixture structured differently from the reference
  solution
- **WHEN** every episode verifier runs against it
- **THEN** all requirement and regression checks pass

### Requirement: Campaign verifier isolation matches existing corpora
Campaign verifier directories SHALL be built as separate no-network images,
SHALL NOT be copied into any agent environment, and SHALL NOT be inherited
between episodes. Protected visible tests and package metadata SHALL be digest
checked as in the existing corpora.

#### Scenario: Smoke validates isolation per episode

- **GIVEN** the campaign smoke entry point
- **WHEN** it runs
- **THEN** it validates baseline staging, Forge staging and verifier isolation
  for every episode
- **AND** it never invokes Harbor or a model

### Requirement: Campaign episodes allow a full Forge loop
Every `forgekit-campaign-v1` episode SHALL declare agent `timeout_sec` of
3600 and episode version `1.1.0`. The campaign manifest SHALL list the same
version for each episode. The timeout applies to both arms. hard-v2 task
timeouts are unchanged.

#### Scenario: Campaign smoke sees the one-hour agent cap
- **GIVEN** the campaign smoke entry point
- **WHEN** it reads each episode `task.toml` and the campaign manifest
- **THEN** every episode version is `1.1.0` in both files
- **AND** every episode agent timeout is 3600 seconds

### Requirement: Confirmed escapes export as a local escape-replay corpus
`evals/harbor/export-escape-replays.mjs --project <path>` SHALL read the project's confirmed escapes and write corpus `forgekit-escape-replays-v1` under `evals/harbor/local/forgekit-escape-replays-v1/`, a path ignored by git. It SHALL write one task per escaped session, never one per fix. The corpus SHALL NOT be written inside the tracked tree, and `corpus-selection.mjs` SHALL register it only when its manifest exists.

#### Scenario: A confirmed escape becomes one task
- **GIVEN** a project whose ledger has a session with two confirmed escapes in one nested repository, an archived change for its slug, and inferred commits for the session
- **WHEN** the operator runs the export with exec allowed
- **THEN** `local/forgekit-escape-replays-v1/corpus.json` lists one task for that session
- **AND** the task's hidden tests are both fixes' test files

#### Scenario: The corpus is not registered without its manifest
- **GIVEN** no local manifest
- **WHEN** the runner selects `forgekit-escape-replays-v1`
- **THEN** selection fails as an unknown corpus before anything runs

#### Scenario: Exported source stays out of git
- **WHEN** the export has written its tasks
- **THEN** `git status --porcelain` in the forgekit checkout lists nothing under `evals/harbor/local/`

### Requirement: The task gives the agent the spec at the session's base
The agent environment SHALL hold the nested repository's tree at the session's base: the parent of its oldest attributed commit. Files that git ignores SHALL NOT be copied, except paths named with `--include`. A named path that is absolute or contains `..` SHALL be refused. The instruction SHALL be the archived change's `proposal.md` followed by its `specs/**/spec.md`, and SHALL NOT contain its `design.md`, `tasks.md`, brief, or any hidden test.

#### Scenario: Ignored secrets are not copied
- **GIVEN** the nested repository has an ignored `server/.env`
- **WHEN** the export runs without `--include`
- **THEN** no task environment contains `.env`
- **AND** with `--include server/.env` the environment does

#### Scenario: Plan output is not in the instruction
- **WHEN** a task's `instruction.md` is written
- **THEN** it contains the proposal and spec text and nothing from `design.md` or `tasks.md`

### Requirement: Every exported task is calibrated
Export SHALL require the exec opt-in. Without it, export SHALL write nothing and exit nonzero. For each session it SHALL build the reference (the escaped head with the fix diffs applied, excluding hidden test files; a fix whose cherry-pick conflicts SHALL be retried once with the fix side winning conflicting hunks, `-X theirs`, and the report SHALL list the fixes applied that way) and run the hidden tests with the recorded replay command in sibling replay worktrees. A task SHALL be kept only when every hidden test fails on the base, fails on the escaped head, and passes on the reference. Every dropped session SHALL be listed in `export-report.json` with one reason: `no-spec`, `no-base`, `unsupported-runner` (no escape of the session has a replay rule), `unsafe-path`, `unsafe-tree` (a symlink, or `export-ignore`/`export-subst` attributes), `missing-test`, `dependency-change` (the reference changes a manifest, lockfile, runner configuration or `.npmrc`/`.yarnrc`/`.yarnrc.yml`), `unpinned-deps` (a replay rule's cwd has no lockfile of its own at the base), `reference-conflict`, `passes-on-base`, `not-failing-on-head`, `not-passing-on-reference`, or `calibration-error`. Calibration SHALL use the same per-test timeout as the verifier. When a replay rule copies ignored files that `--include` does not cover, the report SHALL warn that its tasks cannot be graded without them.

#### Scenario: A test that already passes on the escaped head is dropped
- **GIVEN** a confirmed escape whose hidden test passes on the session's head (the bug came from a later commit)
- **WHEN** the export calibrates it
- **THEN** the session is not in the corpus
- **AND** `export-report.json` lists it with reason `not-failing-on-head`

#### Scenario: Export refuses without the exec opt-in
- **WHEN** the export runs without `FORGEKIT_ALLOW_EXEC=1`
- **THEN** it exits nonzero, names the opt-in, and writes no task

### Requirement: The escape-replay verifier is hidden and solution-independent
Each task SHALL use a separate, no-network verifier environment that holds the hidden test files and the regression set. The agent environment SHALL hold neither. The verifier SHALL copy its own versions of those files over the agent's tree, run them as the untrusted user with the recorded command, using dependencies the verifier image installed from the base manifests (never the agent's), with the application tree read-only and each hidden file restored right before its own run, and write `reward.json`. A test SHALL count as passed only when its command exits 0 and, where the runner's summary is recognised (Jest, Vitest, node --test), it reports at least one passing test and no failures. A command that names one of those three runners must print a summary, and a `node --test` file that ran no test (it reports itself as one passing entry) does not count as a passing test. Calibration judges runs the same way. The reward fields:
- `functional`: every hidden test passes.
- `requirements_met`/`requirements_total`: over the hidden test files.
- `regression`, with `regression_met`/`regression_total`: over the regression set, which is the base test files beside the hidden tests that are identical at base and reference and pass on both.
- `tests_unchanged`: the agent left the regression set's files, the dependency manifests and lockfiles, and the runner configuration unchanged.
- `shippable`: all three binary outcomes.

#### Scenario: The reference solution scores shippable
- **GIVEN** an exported task
- **WHEN** its verifier grades the tree produced by `solution/solve.sh`
- **THEN** `functional`, `regression`, `tests_unchanged` and `shippable` are 1

#### Scenario: Exiting early does not pass
- **GIVEN** an agent tree whose code calls `process.exit(0)` when loaded under the test runner
- **WHEN** the verifier grades it
- **THEN** `functional` is 0

#### Scenario: The untouched base scores not functional
- **WHEN** the verifier grades the unmodified base snapshot
- **THEN** `functional` is 0 and `shippable` is 0
