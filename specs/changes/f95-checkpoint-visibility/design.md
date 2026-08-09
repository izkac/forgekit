# Design

After `forge new` has read Git branch state, load project config and derive a creation-time advisory. The advisory is non-fatal: session creation must succeed. Emit the same warning in JSON (`checkpointWarning`) and stderr for machine and human visibility. Reuse the checkpoint command's protected branch/mode semantics and never auto-create a branch.
