#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
node --input-type=module - "$app_dir/src/expiry.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const original = `  if (order.status !== "pending") return order;
  if (nowMs - order.createdAt < THIRTY_DAYS_MS) return order;`;
const naive = `  if (nowMs - order.createdAt < THIRTY_DAYS_MS) return order;`;
if (!source.includes(original)) throw new Error("pending-only expiry guard not found");
writeFileSync(file, source.replace(original, naive));
NODE
