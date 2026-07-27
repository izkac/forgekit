## 1. Plan progress reader

- [x] 1.1 Add `countTasksMdCheckboxes` + `readPlanTaskProgress` (total, complete, mtime)
- [x] 1.2 Unit tests for checked/unchecked / empty / missing file

## 2. Health + fleet heal

- [x] 2.1 `sessionHealth` uses plan counts in idle reason and `tasks.md` mtime for idle clock
- [x] 2.2 Heal helper overlays + persists session when counts diverge
- [x] 2.3 Fleet reconcile overlays plan progress (and heals session.json)
- [x] 2.4 `forge status` / reminder call heal before reporting

## 3. Docs + integrity

- [x] 3.1 Update implement.md / usage / forge.md so checkbox is source of truth
- [x] 3.2 Spine `notApplicable` + brief; verify with unit suite
