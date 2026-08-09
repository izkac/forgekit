# Tasks

## 1. Versioned corpus infrastructure
- [ ] 1.1 Add RED→GREEN runner tests for an allowlisted corpus selector, legacy default behavior, selected-corpus provenance, and unknown/path-like rejection; implement selection without changing v1.
- [ ] 1.2 Add a checked-in v1 revision lock and CI test proving the manifest and all six task trees remain unchanged.

## 2. Hard concurrency exemplar
- [ ] 2.1 Add a versioned hard-v2 manifest/root and the multi-module `reservation-confirmation-race` seed with protected visible tests and task contracts.
- [ ] 2.2 Add deterministic hidden concurrency/idempotency/expiry verification plus untouched-negative, oracle-positive, and alternate-positive host evidence.
- [ ] 2.3 Add semantic mutant qualification for meaningful agent tests; reject infrastructure failures as mutant kills.

## 3. Closeout
- [ ] 3.1 Document corpus selection and v2 scope, run focused/full eval/workspace/lint/smoke/E2E verification, obtain independent adversarial approval, archive, and merge without publishing or invoking a provider.
