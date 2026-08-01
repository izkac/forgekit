# Design — cleanup-openspec-plan-dir

## Decision

Replace `loadProjectConfig` + `DEFAULT_SPECS_DIR` in `hasLiveChangeDir` with:

```js
resolveProjectPlanEngine(process.cwd(), { useUserDefault: false }).dir
```

That already maps `engine: 'openspec'` → `openspec` and `engine: 'specs'` →
`specs` when `dir` is absent.

## Alternatives rejected

- `resolveChangeDir({ forWrite: true })` alone — with unknown `planType` it
  prefers the openspec write path even when only a specs change exists; engine
  resolution from project config is the load-bearing signal for F73.
- Dual-check both `openspec/changes` and `specs/changes` — over-protects and
  diverges from how the rest of Forge picks a root.

## Risks

None material; same resolver every other plan-aware command uses.
