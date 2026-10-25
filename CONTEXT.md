# Forgekit

Agent skills and a CLI that run coding-agent work through enforced gates. The primary user is the
maintainer; the package is public but no outside users are supported yet.

## Language

**Forge session**:
One piece of agent work driven through Forge's phases and gates, from triage to done.
_Avoid_: run, workflow

**Plain session**:
The same kind of agent work done without Forge; the baseline every Forge claim is measured against.
_Avoid_: vanilla, no-forge run

**Promise**:
In real use, the **Escape rate** of **Forge sessions** falls over time (primary); in evals, **Forge sessions** beat **Plain sessions** on the hidden verifier.

**Broken change**:
A change that an eval's hidden verifier rejects, or that has an **Escape** in real use.
_Avoid_: bad change, regression (too broad)

**Escape**:
A fix or revert commit that touches a change's code within 14 days of the session reaching done.
_Avoid_: bug, defect (those exist without a done change)

**Escape candidate**:
A later commit, within 14 days of done, that modifies or deletes lines the change added; it becomes an **Escape** only when the operator confirms it.
_Avoid_: suspected bug

**Commit range**:
The base..head commits recorded for a change in each repository it touched; for sessions recorded before per-repository ranges, inferred from the session's time window.

**Escape rate**:
The share of done **Forge sessions** with at least one **Escape**; the primary measure of the **Promise**.

**Escape replay**:
A local eval task built from one confirmed **Escape**: the change's base commit and spec as input, and a hidden test that fails on the escaped code and passes on the fixed code.
_Avoid_: regression task, synthetic task

**Gate fire**:
One refusal by a Forge gate that forces a correction, logged with gate, session and time.
_Avoid_: gate hit, block

## Relationships

- The **Promise** compares **Forge sessions** with **Plain sessions** only in evals; real use has no **Plain session** baseline, only the **Escape rate** trend
- A **Broken change** is judged by the eval verifier (controlled) or by **Escapes** (real use); the **Escape rate** is primary
- One done **Forge session** can have zero or more **Escapes**
- Confirming an **Escape** includes supplying its replay test: the fix commit's test if it has one, otherwise one written by the operator
- Each confirmed **Escape** yields one **Escape replay**; replays are where evals compare **Forge sessions** with **Plain sessions**
- A gate with no **Gate fire** across the fleet by 2027-04-24 is cut or moved behind thorough pace; zero **Escapes** alone never justifies a cut, since a working gate prevents them
- A **Commit range** (per repository) yields zero or more **Escape candidates**; the operator confirms or dismisses each one

## Flagged ambiguities

- "broken change" — resolved: eval verifier rejection or a real-use **Escape**.
- "Forge beats plain" was first stated for real use — resolved: the comparison holds only in evals; real use tracks the trend, which cannot separate Forge's effect from model upgrades.
- "session score" is a process-compliance grade, not a measure of the **Promise**; a high score does not mean no **Escape**.
