# Delta for Evaluation Corpus

## ADDED Requirements

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
