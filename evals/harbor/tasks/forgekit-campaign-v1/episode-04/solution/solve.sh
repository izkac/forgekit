#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
cp "$script_dir/app.mjs" "$app_dir/src/app.mjs"
