# Delta for Project Wiring

## ADDED Requirements

### Requirement: Hooks never pass untrusted text through a shell
A hook that spawns `forge` with caller-supplied text — the user's prompt, a
file path, any value it did not author — SHALL NOT use a shell on platforms
where one is unnecessary. Node joins argv into a command string when
`shell: true`, without quoting, so any metacharacter in that text is
interpreted rather than passed through.

A shell SHALL be used only on win32, where `forge` resolves to a `.cmd` shim
and cannot be spawned directly, and quoting SHALL be confined to that branch.

Prompt text containing shell metacharacters SHALL reach `forge` unchanged.
The realistic trigger is not an attacker: a backtick or a semicolon in a
pasted code snippet is ordinary prompt content, and it fires on every
`UserPromptSubmit` in a wired project.

#### Scenario: Metacharacters in a prompt are not executed

- GIVEN a wired project
- WHEN a user prompt containing `; touch <marker> #` is submitted
- THEN no marker file is created

#### Scenario: A prompt containing metacharacters is relayed intact

- GIVEN a prompt containing a backtick, `$(…)`, a semicolon, a pipe and quotes
- WHEN the hook relays it to `forge`
- THEN `forge` receives the prompt text unchanged

#### Scenario: The shipped hook and the project copy stay identical

- GIVEN the template hooks under `templates/project/claude/hooks/`
- WHEN compared against this repo's own `.claude/hooks/` copies
- THEN they are byte-identical
