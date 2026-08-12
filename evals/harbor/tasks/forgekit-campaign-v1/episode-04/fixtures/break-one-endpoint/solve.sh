#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
node --input-type=module - "$app_dir/src/app.mjs" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const source = readFileSync(file, "utf8");
const original = `      if (request.method === "POST" && action === "refunds" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;`;
const broken = `      if (request.method === "POST" && action === "refunds" && parts.length === 3) {
        const replayed = { handled: false, scope: null };
        if (replayed.handled) return;`;
if (!source.includes(original)) throw new Error("refund idempotency replay not found");
writeFileSync(file, source.replace(original, broken));
NODE
