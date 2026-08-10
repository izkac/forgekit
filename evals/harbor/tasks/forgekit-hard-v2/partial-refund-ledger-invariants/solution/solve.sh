#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
cp "$script_dir/../fixtures/refund-ledger-invariants.test.mjs" "$app_dir/src/refund-ledger-invariants.test.mjs"
node --input-type=module - "$app_dir/src/refund-service.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const buggy = "const consumed = successful.length > 0 ? successful[successful.length - 1].amountCents : 0;";
const fixed = "const consumed = successful.reduce((total, entry) => total + entry.amountCents, 0);";
if (!source.includes(buggy)) throw new Error("refund admission expression not found");
writeFileSync(file, source.replace(buggy, fixed));
NODE
