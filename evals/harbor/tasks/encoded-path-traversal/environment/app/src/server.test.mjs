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
test("public files and missing responses remain stable", async () => {
  const publicFile = await fetch(`${baseURL}/index.txt`);
  assert.equal(publicFile.status, 200);
  assert.equal(publicFile.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await publicFile.text(), "public index\n");

  const missing = await fetch(`${baseURL}/missing.txt`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await missing.text(), "Not found\n");
});
/* END PRE-EXISTING VISIBLE TEST */
