# Design

The `forge` router injects a prepended Node `--require` preload into its immediate command child. The preload removes only its injected option before command execution so descendants do not inherit Forge-specific behavior, then exits 0 for stdout EPIPE. Other stream errors are rethrown. This covers every routed command without editing each command module.
