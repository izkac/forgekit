#!/bin/sh
set -eu

app_dir=${HARBOR_APP_DIR:-/app}
server="$app_dir/src/server.mjs"
node --input-type=module - "$server" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
let source = readFileSync(file, "utf8");
source = source.replace(
  "  const cell = String(value);",
  "  let cell = String(value);\n  if (/^[=+\\-@]/.test(cell)) cell = `\'${cell}`;"
);
writeFileSync(file, source);
NODE

cat > "$app_dir/src/csv-formula-boundary.test.mjs" <<'NODE'
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "./server.mjs";

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
}));

test("CSV formula markers are neutralized only at the cell boundary", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/export.csv`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Equals,equals@example\.test,'=2\+3\n/);
  assert.match(body, /Plus,plus@example\.test,"'\+SUM\(1,1\)"\n/);
  assert.match(body, /Minus,minus@example\.test,'-10\+20\n/);
  assert.match(body, /At,at@example\.test,'@SUM\(1:2\)\n/);
  assert.match(body, /Safe,safe@example\.test,reference=2\+3\n/);
});
NODE
