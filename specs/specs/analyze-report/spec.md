# Analyze Report Spec

## Purpose

Describe this capability.

## Requirements

### Requirement: Coverage distinguishes measured, predates-telemetry, and collection-failed
`forge analyze` SHALL report three coverage buckets for analysed sessions —
measured (`metrics.available === true`), predates-telemetry (no metrics object
on the digest), and collection-failed (`metrics.available === false`) — instead
of only a single blended ratio. The measured ratio MAY remain as a secondary
figure.

#### Scenario: Blended history is reported in three buckets

- GIVEN digests with measured, missing-metrics, and available-false entries
- WHEN analyze runs
- THEN coverage reports measured, predatesTelemetry, and collectionFailed
  counts that sum to sessionsTotal
- AND the rendered lead line names all three buckets
