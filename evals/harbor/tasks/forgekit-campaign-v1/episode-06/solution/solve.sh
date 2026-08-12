#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
cp "$script_dir/app.mjs" "$app_dir/src/app.mjs"
cp "$script_dir/expiry.mjs" "$app_dir/src/expiry.mjs"
cp "$script_dir/file-store.mjs" "$app_dir/src/file-store.mjs"
