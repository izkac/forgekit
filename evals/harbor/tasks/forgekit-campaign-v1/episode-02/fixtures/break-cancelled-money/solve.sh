#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
node --input-type=module - "$app_dir/src/app.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const original = `        const chargedBefore = order.chargedCents;
        const refundedBefore = order.refundedCents;
        transition(order, "cancelled");
        order.chargedCents = chargedBefore;
        order.refundedCents = refundedBefore;`;
const broken = `        transition(order, "cancelled");
        order.chargedCents = 0;
        order.refundedCents = 0;`;
if (!source.includes(original)) throw new Error("cancel money preservation not found");
writeFileSync(file, source.replace(original, broken));
NODE
