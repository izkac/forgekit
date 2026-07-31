# Pace Signals Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Thorough-risk corpus pins today's classification
The system SHALL maintain a fixture of real sentences labelled `risky` or
`benign` for the thorough-risk detector. A test SHALL assert that
`isHighRiskText` agrees with every fixture row's `expect` label. When any
row disagrees, the test failure message SHALL name each mismatched
sentence id together with expected and actual sides. The fixture SHALL
include the risky examples named by finding F11, hard-wrapped variants
that place a line break before `contract`, benign ordinary-software-English
uses of related vocabulary, and sentences sourced from archived change
prose under `specs/changes/archive/`.

#### Scenario: Corpus matches current detector
- GIVEN the thorough-re corpus fixture on disk
- WHEN the thorough-re corpus test runs
- THEN every row's `isHighRiskText(text)` equals `(expect === "risky")`
- AND the command exits 0

#### Scenario: A flipped sentence is named
- GIVEN a fixture row whose expect no longer matches `isHighRiskText`
- WHEN the thorough-re corpus test runs
- THEN the failure output includes that row's `id`
- AND states the expected side and the actual side

### Requirement: Corpus does not narrow the detector by itself
Shipping the corpus SHALL NOT change `THOROUGH_RE` / `isHighRiskText`
behaviour. Narrowing remains a separate, measured change that must keep
the corpus test green or deliberately update expects with a measured
rationale.

#### Scenario: Detector unchanged by this change
- GIVEN the preferences thorough-risk examples that already pass in
  `preferences.test.mjs`
- WHEN those tests run after the corpus lands
- THEN they still pass without edits to `THOROUGH_RE`

### Requirement: Contract risk requires a qualifier with flexible whitespace
`THOROUGH_RE` / `isHighRiskText` SHALL treat `contract` / `contracts` as a
thorough-risk signal only when a recognised qualifier precedes the noun, or
when the noun is followed by a recognised test/breach family word. The
whitespace between qualifier and noun SHALL be `\s+` (any whitespace,
including a newline from hard-wrapped plan prose). Bare `contract` /
`contracts` with no such neighbour SHALL NOT, by itself, classify text as
high-risk.

Recognised preceding qualifiers: `public`, `data`, `api`, `openapi`, `cli`,
`wire`, `schema`, `smart`, `service`, `breaking`, `interface`.
Recognised following family: `test`, `tests`, `testing`, `breach`.

#### Scenario: F11 risky sentences stay high-risk

- **GIVEN** the sentences "alters the public contract of the /v1/orders
  endpoint", "breaking change to the data contract", and "the OpenAPI
  contract gains two required fields"
- **WHEN** `isHighRiskText` runs on each
- **THEN** each result is true

#### Scenario: Hard-wrapped qualifier still matches

- **GIVEN** "alters the public\ncontract of the /v1/orders endpoint"
- **WHEN** `isHighRiskText` runs
- **THEN** the result is true

#### Scenario: Bare software-English contract does not escalate

- **GIVEN** "byte-identical (the existing \"must never block work\" contract)"
  or "the same contract as readLedger"
- **WHEN** `isHighRiskText` runs
- **THEN** the result is false

### Requirement: Narrowing is measured against the thorough-re corpus
Any change to `THOROUGH_RE`'s contract arm SHALL keep
`thorough-re-corpus.test.mjs` green, or deliberately update fixture `expect`
labels only for rows whose side change was measured and recorded in the
change's design or fixture commentary.

#### Scenario: Corpus green after narrowing

- **GIVEN** the thorough-re corpus fixture after this change
- **WHEN** `node --test packages/cli/src/thorough-re-corpus.test.mjs` runs
- **THEN** the command exits 0
