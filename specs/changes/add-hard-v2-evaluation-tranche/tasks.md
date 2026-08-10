# Tasks

## 1. Manifest-driven hard-v2 preflight
- [x] 1.1 Add a failing `evals/harbor/smoke.test.mjs` case proving task metadata validation discovers each selected task's semantic-mutant evidence without a reservation-specific filename, then update `evals/harbor/smoke-hard-v2.mjs` to satisfy it while deriving three Docker contexts per selected entry. Verify with `node --test evals/harbor/smoke.test.mjs`.

## 2. Security vertical slice
- [x] 2.1 Add the agent-visible `evals/harbor/tasks/forgekit-hard-v2/tenant-signed-downloads` Node 22 fixture, protected visible tests, task metadata, and instruction contract. Verify the protected visible suite passes while an explicit cross-tenant replay reproduction fails.
- [x] 2.2 Add its separate no-network verifier, hidden probes, semantic tenant-omission mutant, known-good solution, structurally distinct alternate positive, and task-specific host suite. Prove untouched, tamper, no-added-test, and mutant negatives plus both positives with `node --test evals/harbor/corpus-hard-v2-tenant-signed-downloads.test.mjs`.
- [x] 2.3 Register `tenant-signed-downloads` in `evals/harbor/corpora/forgekit-hard-v2.json`, the hard-v2 host-suite registry, smoke expectations, and evaluation docs. Verify `npm run smoke:evals:hard-v2` reports the Security task and its three contexts.

## 3. Tests vertical slice
- [x] 3.1 Add the agent-visible `evals/harbor/tasks/forgekit-hard-v2/partial-refund-ledger-invariants` fixture, protected visible tests, task metadata, and instruction contract. Verify the visible suite passes while a cumulative partial-refund boundary reproduction fails.
- [x] 3.2 Add its separate verifier, hidden ledger/effect probes, semantic latest-entry mutant, known-good solution, alternate positive, and task-specific host suite. Prove the required negative and positive matrix with `node --test evals/harbor/corpus-hard-v2-partial-refund-ledger-invariants.test.mjs`.
- [x] 3.3 Register `partial-refund-ledger-invariants` in the manifest, smoke registry/expectations, and evaluation docs. Verify `npm run smoke:evals:hard-v2` reports the Tests task and its three contexts.

## 4. Integration vertical slice
- [x] 4.1 Add the agent-visible `evals/harbor/tasks/forgekit-hard-v2/carrier-event-reconciliation` fixture, protected visible tests, task metadata, and instruction contract. Verify the visible suite passes while carrier-ID collision and late-event reproductions fail.
- [x] 4.2 Add its separate verifier, deterministic recording-adapter probes, semantic reconciliation mutant, known-good solution, alternate positive, and task-specific host suite. Prove the required negative and positive matrix with `node --test evals/harbor/corpus-hard-v2-carrier-event-reconciliation.test.mjs`.
- [x] 4.3 Register `carrier-event-reconciliation` in the manifest, smoke registry/expectations, and evaluation docs. Verify `npm run smoke:evals:hard-v2` reports the Integration task and its three contexts.

## 5. Product-loop and corpus verification
- [x] 5.1 Update `evals/README.md` and `docs/agentic-evals.md` with the four-task incomplete-corpus status, task contracts, twelve-context smoke behavior, and calibration language distinguishing one paired repetition from two-repetition counterbalancing.
- [x] 5.2 Run `forge e2e run`, the three task-specific host suites, `npm run test:evals`, `npm run lint:evals`, and `npm run smoke:evals:hard-v2`; record independent per-slice and final review evidence.
