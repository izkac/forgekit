#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
mkdir -p "$app_dir/src/handlers"
cp "$script_dir/app.mjs" "$app_dir/src/app.mjs"
cp "$script_dir/handlers/orders.mjs" "$app_dir/src/handlers/orders.mjs"
cp "$script_dir/handlers/transitions.mjs" "$app_dir/src/handlers/transitions.mjs"
cp "$script_dir/handlers/refunds.mjs" "$app_dir/src/handlers/refunds.mjs"
