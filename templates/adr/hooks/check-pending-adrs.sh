#!/usr/bin/env bash
# Pending-ADR backstop: list archived proposals missing ADR link and No-ADR stamp.
# Honors .forge/config.json adr.enabled === false (prints nothing).

set -euo pipefail

repo_root="${1:-}"
if [[ -z "$repo_root" ]] && git rev-parse --show-toplevel >/dev/null 2>&1; then
  repo_root="$(git rev-parse --show-toplevel)"
fi
if [[ -z "$repo_root" ]]; then
  exit 0
fi

cd "$repo_root"

cfg=".forge/config.json"
if [[ -f "$cfg" ]] && command -v node >/dev/null 2>&1; then
  enabled="$(node -e "
    try {
      const c=JSON.parse(require('fs').readFileSync('$cfg','utf8'));
      process.stdout.write(c.adr && c.adr.enabled === false ? '0' : '1');
    } catch { process.stdout.write('1'); }
  ")"
  if [[ "$enabled" == "0" ]]; then
    exit 0
  fi
fi

shopt -s nullglob
archive_glob=(openspec/changes/archive/*/proposal.md)
if [[ ${#archive_glob[@]} -eq 0 ]]; then
  exit 0
fi

pending_files=()
for f in "${archive_glob[@]}"; do
  if grep -q 'ADR-[0-9]' "$f" 2>/dev/null; then
    continue
  fi
  if grep -Fq 'No ADR — non-architectural change' "$f" 2>/dev/null; then
    continue
  fi
  pending_files+=("$f")
done

if ((${#pending_files[@]} == 0)); then
  exit 0
fi

pending="$(printf '%s\n' "${pending_files[@]}" | head -10)"

cat <<EOF
Archived OpenSpec changes whose proposal.md does not reference an ADR yet:

${pending}

If any had architectural impact, run the archive-to-adr skill.
Otherwise add a one-line stamp to each proposal.md:
  'No ADR — non-architectural change'
EOF
