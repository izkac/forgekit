# Episode 5 — Split handlers into modules

You inherit the order service from episodes 1–4. Restructure the code so
request handlers live in separate modules. HTTP behaviour must stay exactly
the same: status machine, ledger, refunds, idempotency keys, and the rule
that cancelled is terminal and moves no money.

Keep `package.json` and `src/orders.test.mjs` unchanged. Runtime seams are
unchanged: `PORT`, `NOW_MS`, print `listening on <port>`. Start with
`node src/server.mjs`.

Put domain handlers in more than one module under `src/handlers/`. Do not
drop edge cases while moving code.

## When you cannot meet a requirement

If a requirement cannot be satisfied without violating one already established,
write `BLOCKED.md` at the repository root naming both requirements. Do not
implement a silent compromise.
