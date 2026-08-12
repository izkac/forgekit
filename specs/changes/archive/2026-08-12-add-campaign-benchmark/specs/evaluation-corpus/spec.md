# Delta for Evaluation Corpus

## ADDED Requirements

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
