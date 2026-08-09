# Design

## Corpus selection and immutability

A checked-in registry maps safe public corpus IDs to checked-in manifest/task roots. It never accepts filesystem paths. Omission selects `forgekit-held-out-v1`. Plans and trial manifests bind the selected ID, manifest revision, task revision, and task semantic version. A v1 lock test hashes its manifest and all six task trees so accidental historical mutation fails CI.

`forgekit-hard-v2` lives under a distinct manifest and task root. It starts with one reviewed exemplar and is not described as a six-category corpus until later slices add and freeze the remaining categories. Mixed-corpus aggregation continues to fail closed.

## Hard exemplar

`reservation-confirmation-race` is a multi-module reservation confirmation system. The seed passes ordinary sequential visible tests but has check-then-act races across reservation, idempotency, inventory, payment, and expiry state. The documented contract requires one atomic reservation claim, stable replay, payload conflict, failure release/retry, expiry precedence at the boundary, and independent progress for unrelated reservations.

The hidden verifier uses injected stores, fixed IDs, a manual clock, and deferred barriers. Correctness never depends on sleeps. It grades observable module/HTTP contracts rather than source structure. Separate complete concurrency mutants qualify agent-added tests only when those tests produce assertion failures; import, syntax, startup, or timeout failures do not count. An internally different alternate-positive implementation guards against oracle-prescriptive grading.

## Compatibility and claims

V1 files, default selection, smoke output, and historical results remain unchanged. V2 is a public separate-verifier pilot, not private or contamination-free. A passing exemplar validates task/verifier integrity, not treatment effectiveness. Provider-backed trials remain a later, explicitly budgeted step after the corpus slice merges.
