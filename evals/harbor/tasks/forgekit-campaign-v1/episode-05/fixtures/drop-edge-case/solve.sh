#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
node --input-type=module - "$app_dir/src/handlers/transitions.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const original = `  if (!Number.isSafeInteger(body.amountCents) || body.amountCents !== order.totalCents) {
    throw new OrderError("invalid_amount", "Charge amountCents must equal the order total", 400);
  }`;
const dropped = `  if (!Number.isSafeInteger(body.amountCents)) {
    throw new OrderError("invalid_amount", "Charge amountCents must be an integer", 400);
  }`;
if (!source.includes(original)) throw new Error("charge amount edge case not found");
writeFileSync(file, source.replace(original, dropped));
NODE
