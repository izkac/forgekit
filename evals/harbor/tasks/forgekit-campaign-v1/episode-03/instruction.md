# Episode 3 — Refunds on cancelled orders

You inherit the order and refund service from episodes 1 and 2.

Change the service so that **refunds may be issued on cancelled orders**. A
cancelled order with a remaining charged balance must accept
`POST /orders/:id/refunds` and increase `refundedCents`.

Keep `package.json` and `src/orders.test.mjs` unchanged. Runtime seams are
unchanged: `PORT`, `NOW_MS`, print `listening on <port>`.

## When you cannot meet a requirement

If a requirement cannot be satisfied without violating one already established,
write `BLOCKED.md` at the repository root naming both requirements. Do not
implement a silent compromise.
