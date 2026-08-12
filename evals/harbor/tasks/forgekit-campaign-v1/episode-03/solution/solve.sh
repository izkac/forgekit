#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-"$(pwd)"}
cat > "$app_dir/BLOCKED.md" <<'EOF'
# Blocked

Cannot implement refunds on cancelled orders without breaking the established
requirement that cancelled is terminal and moves no money.
EOF
