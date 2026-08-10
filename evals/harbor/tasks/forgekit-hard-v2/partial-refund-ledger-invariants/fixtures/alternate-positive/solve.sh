#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=${HARBOR_APP_DIR:-$(pwd)}
cp "$script_dir/refund-ledger-invariants.alternate.test.mjs" "$app_dir/src/refund-ledger-invariants.alternate.test.mjs"
python3 - "$app_dir/src/refund-service.mjs" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
buggy = "const consumed = successful.length > 0 ? successful[successful.length - 1].amountCents : 0;"
fixed = "let consumed = 0;\n    for (const entry of successful) consumed += entry.amountCents;"
if buggy not in source:
    raise SystemExit("refund admission expression not found")
path.write_text(source.replace(buggy, fixed))
PY
