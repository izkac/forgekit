#!/usr/bin/env bash
# Agent reminder after a successful OpenSpec archive (stdout only).
# Usage: openspec-archive-agent-message.sh <change-slug>
# Paths come from .forge/config.json (adr.dir / adr.decisionsDoc) when present.

set -euo pipefail

change_name="${1:?change slug required}"

adr_dir="docs/adr"
decisions_doc="docs/decisions.md"
cfg=".forge/config.json"
if [[ -f "$cfg" ]] && command -v node >/dev/null 2>&1; then
  eval "$(node -e "
    const fs=require('fs');
    try {
      const c=JSON.parse(fs.readFileSync('$cfg','utf8'));
      const a=c.adr||{};
      if (a.enabled === false) { console.log('ENABLED=0'); process.exit(0); }
      console.log('ENABLED=1');
      if (a.dir) console.log('ADR_DIR=' + JSON.stringify(a.dir));
      if (a.decisionsDoc) console.log('DECISIONS=' + JSON.stringify(a.decisionsDoc));
    } catch { console.log('ENABLED=1'); }
  ")"
  if [[ "${ENABLED:-1}" == "0" ]]; then
    cat <<EOF
OpenSpec change '${change_name}' was archived. ADRs are disabled for this project
(\`.forge/config.json\` → adr.enabled: false). No archive-to-adr follow-up.

Suggested commit (display only — do NOT commit unless the user asks):

openspec: archive ${change_name}
EOF
    exit 0
  fi
  adr_dir="${ADR_DIR:-$adr_dir}"
  decisions_doc="${DECISIONS:-$decisions_doc}"
fi

cat <<EOF
OpenSpec change '${change_name}' was just archived.

1. archive-to-adr: locate openspec/changes/archive/YYYY-MM-DD-${change_name}/, open proposal.md, and evaluate an ADR (${decisions_doc}). If yes: ${adr_dir}/NNNN-<topic>.md, update ${adr_dir}/README.md, add a ## Decision record to proposal.md. If no: add one line to proposal.md: No ADR — non-architectural change.

2. Suggested commit (display only — do NOT run git commit / push / gh pr create unless the user explicitly asks):

openspec: archive ${change_name}
EOF
