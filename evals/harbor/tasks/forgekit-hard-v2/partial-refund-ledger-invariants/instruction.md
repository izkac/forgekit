# Repair Cumulative Partial-Refund Accounting

The dependency-free Node 22 payment service in `/app` processes refunds for stored
charges. It has a `RefundService`, an injected charge store, an append-only refund
ledger, a recording refund gateway, and a local HTTP endpoint. A single refund and
ordinary validation work, but sequential partial refunds can admit too much value.

Repair the production code so that:

- successful refund amounts for one charge are accounted for cumulatively;
- a successful refund is accepted only when its amount is no greater than the
  remaining charge balance, including when it is exactly the remaining balance;
- validation errors, missing charges, rejected over-limit attempts, and gateway
  failures do not consume refundable balance (a failed attempt may remain in the
  ledger for audit);
- replaying a successful idempotency key returns the original result without a
  second gateway call or ledger append; and
- reusing a successful key with a different amount fails before any gateway or
  ledger effect, while existing HTTP behavior remains compatible.

The real HTTP refund route must compose and invoke `RefundService`, the injected
stores/ledger, and the gateway. Keep the fixture sequential; concurrency is not
part of this task.

First add table-driven boundary tests in a new `src/*.test.mjs` file. Build those
behaviors RED→GREEN one at a time, then repair production code. Derive expected
amounts from the fixture data in tests rather than copying totals from this
instruction. Do not edit or replace the protected visible test after adding it.

Run the app's visible suite and the narrow host reproduction command supplied by
the repository task harness. Do not add verifier, oracle, alternate, manifest,
shared-smoke, or documentation files.
