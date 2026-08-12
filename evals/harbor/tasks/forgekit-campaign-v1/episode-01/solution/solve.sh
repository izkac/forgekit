#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
mkdir -p "$app_dir/src"
cp "$script_dir/app.mjs" "$app_dir/src/app.mjs"
cp "$script_dir/orders.mjs" "$app_dir/src/orders.mjs"
cp "$script_dir/store.mjs" "$app_dir/src/store.mjs"
