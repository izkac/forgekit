# Delta for review-evidence

## ADDED Requirements

### Requirement: Published self-declaration phrases stay true in the census

The closed list of self-declaration phrases published in Forge's implement-phase
guidance SHALL each cause `reviewCensus` to grade a review as self-authored when
placed in the attribution region. A regression test SHALL extract those phrases
from the shipped markdown rather than hard-coding a parallel list.

#### Scenario: Each closed-list phrase grades self

- GIVEN the closed phrase list in `skills/forge/phases/implement.md`
- WHEN a review file's attribution region contains one listed phrase
- THEN reviewCensus grades that review as self-authored
