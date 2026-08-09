import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createServer } from "./server.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseURL = `http://127.0.0.1:${port}`;

after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

/* BEGIN PRE-EXISTING VISIBLE TEST */
test("CSV header, ordinary escaping, and missing routes remain stable", async () => {
  const exported = await fetch(`${baseURL}/export.csv`);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "text/csv; charset=utf-8");
  const body = await exported.text();
  assert.match(body, /^name,email,note\n/);
  assert.match(body, /Ada,ada@example\.test,"Quarterly, reviewer"\n/);
  assert.match(body, /Safe,safe@example\.test,reference=2\+3\n/);

  const missing = await fetch(`${baseURL}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found\n");
});
/* END PRE-EXISTING VISIBLE TEST */
