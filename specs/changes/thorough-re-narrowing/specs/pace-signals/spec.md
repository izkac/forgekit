# Delta for pace-signals

## ADDED Requirements

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
