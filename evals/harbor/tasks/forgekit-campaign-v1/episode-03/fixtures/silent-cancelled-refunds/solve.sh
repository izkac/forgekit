#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
node --input-type=module - "$app_dir/src/app.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const original = 'if (order.status === "cancelled" || order.status === "pending")';
const silent = 'if (order.status === "pending")';
if (!source.includes(original)) throw new Error("refund admission guard not found");
writeFileSync(file, source.replace(original, silent));
NODE
