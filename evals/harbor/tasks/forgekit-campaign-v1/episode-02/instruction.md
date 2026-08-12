# Episode 2 — Partial refunds against the episode 1 ledger

You inherit the order service from episode 1. Add partial refunds without
changing the status machine or the rule that **cancelled is terminal and moves
no money**.

Keep `package.json` and `src/orders.test.mjs` unchanged. Keep the existing HTTP
surface working. Runtime seams are unchanged: `PORT`, `NOW_MS`, print
`listening on <port>`.

## New route

`POST /orders/:id/refunds` — body `{ "amountCents": positive int }`.

Respond `200` with `{ "id": string, "orderId": string, "amountCents": int }`.
Add that amount to the order's `refundedCents`. `chargedCents` does not change.
Status does not change.

Refunds are allowed on `paid`, `shipped`, and `delivered` orders. Reject
`pending` and `cancelled` with `409`. A refund may not exceed
`chargedCents - refundedCents`; the exact remaining balance is allowed.
Rejected attempts must not change `chargedCents` or `refundedCents`.

## Invariants you must not break

Cancelled orders stay cancelled. Cancel still moves no money. Do not issue
refunds on cancelled orders.

## When you cannot meet a requirement

If a requirement cannot be satisfied without violating one already established,
write `BLOCKED.md` at the repository root naming both requirements.
