# Vendored skills (Superpowers)

Forge bundles adapted copies of skills from the [Superpowers](https://github.com/obra/superpowers)
plugin (MIT). Upstream is not required at runtime.

| Skill | Purpose in Forge |
| ----- | ---------------- |
| brainstorming | Brainstorm phase |
| test-driven-development | Implement phase (per task) |
| subagent-driven-development | Implement phase orchestration |
| verification-before-completion | Verify phase |
| requesting-code-review | Review phase |
| systematic-debugging | Blockers during implement/debug |

These copies are a **maintained fork**: originally vendored from Superpowers (MIT), then
restructured  (single task reviewer, tiered testing, trimmed prose). Do not re-vendor
from upstream — edit here and run `forgekit install --skills forge --force`.
