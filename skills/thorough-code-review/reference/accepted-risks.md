# Accepted risks digest (inject into every scout & skeptic packet)

Project-specific list of risks that ADRs (or equivalent) have **formally accepted**. Inject into every scout and skeptic packet so subagents do not re-escalate them.

**Do not flag these as findings** unless a listed re-open trigger has fired; cite the decision record instead. If a claim is not covered here, check the project's ADR / decision docs before confirming a security finding.

**Maintenance:** update whenever a decision that accepts, changes, or re-opens a risk is recorded.

## Template

```markdown
## DEC-NNNN — short title

Accepted, NOT findings:
- …

**Re-open triggers:** …
```

## Cross-cutting patterns to check (not accepted risks)

List project invariants that *are* fair game for findings (idempotency, route-parity tests, index rules, etc.).

---

See [examples/accepted-risks-janus.md](../examples/accepted-risks-janus.md) for a filled-in digest from the originating monorepo.
