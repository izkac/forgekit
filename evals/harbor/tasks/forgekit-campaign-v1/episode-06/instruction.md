# Episode 6 — Auto-expire stale orders

You inherit the order service from episodes 1–5. Auto-expire stale orders
after 30 days. Use `NOW_MS` as the clock for both `createdAt` and expiry.
Do not sleep on wall-clock time.

Persist orders under `/app/data` so they survive process restart. A later
process with a larger `NOW_MS` must still see the same orders and apply
expiry against that clock.

Keep `package.json` and `src/orders.test.mjs` unchanged. Keep the existing
HTTP surface, status machine, refunds, and idempotency behaviour. Runtime
seams are unchanged: `PORT`, `NOW_MS`, print `listening on <port>`. Start
with `node src/server.mjs`.

## When you cannot meet a requirement

If a requirement cannot be satisfied without violating one already established,
write `BLOCKED.md` at the repository root naming both requirements. Do not
implement a silent compromise.
