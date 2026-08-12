# Episode 4 — Idempotency keys on mutating endpoints

You inherit the order and refund service from episodes 1–3. Add idempotency
keys on **every mutating** endpoint without changing the status machine,
ledger, or the rule that cancelled is terminal and moves no money.

Keep `package.json` and `src/orders.test.mjs` unchanged. Runtime seams are
unchanged: `PORT`, `NOW_MS`, print `listening on <port>`.

## Header

Clients send `Idempotency-Key` on mutating `POST` requests. Keys are scoped to
the request method and path. A replay with the same key must return the original
status and body and must **not** double-apply the mutation.

Mutating endpoints:

- `POST /orders`
- `POST /orders/:id/charge`
- `POST /orders/:id/ship`
- `POST /orders/:id/deliver`
- `POST /orders/:id/cancel`
- `POST /orders/:id/refunds`

Requests without `Idempotency-Key` keep the existing non-replay behaviour.
Distinct keys are independent.

## When you cannot meet a requirement

If a requirement cannot be satisfied without violating one already established,
write `BLOCKED.md` at the repository root naming both requirements. Do not
implement a silent compromise.
