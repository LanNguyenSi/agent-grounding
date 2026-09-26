# Pause sentinel (optional, read-only)

An optional, read-only mechanism to silence both hook layers on Claude Code and opencode without an approved report.

Set `UNDERSTANDING_GATE_PAUSE_FILE` to the path of a pause-sentinel JSON
file (`{pausedAt, expiresAt, reason, pausedBy}`) to make `UserPromptSubmit`,
`PreToolUse`, and opencode's `tool.execute.before` enforcement hook stay
silent (or, for `PreToolUse` / `tool.execute.before`, allow instead of
deny/block) while that sentinel is active: the `UserPromptSubmit` hook
skips the Understanding Report injection, and the `PreToolUse` and
`tool.execute.before` hooks skip their deny/block (all three use the
exact same reader, so a given sentinel file reads the same way on every
path). The `Stop` hook only persists reports and is unaffected by a
pause. A `PreToolUse` or `tool.execute.before` pause that overrides what
would otherwise have been a block or force-bypass is audit-logged as a
`paused_allow` entry; a pause that changes nothing (a read-only tool, an
already-approved report) stays silent, same as without a pause. This
package only ever reads the sentinel file; it never creates, writes, or
deletes it, and never manages expiry. Unset (the default) means no pause
check at all on any hook or plugin.

`UNDERSTANDING_GATE_PAUSE_FILE` must be set on **both** hook lines by any
consumer that wires `understanding-gate-claude-pre-tool-use` directly
(rather than through env plumbing that already exports it for the whole
process) -- each hook only sees the env var on its own command line, so a
sentinel wired to one hook and not the other silences only that one.

The sentinel is unsigned and operator-owned: this package trusts whatever
is at the configured path and applies no signature or origin check, so
treat write access to the sentinel file itself as equivalent to write
access to pause enforcement everywhere it is checked.

## opencode

The opencode `tool.execute.before` enforcement hook honors the same
pause sentinel, through the exact same `isPaused` reader as the Claude
Code hooks (no second parser), behaving like the Claude Code
`PreToolUse` path: an active sentinel overriding what would otherwise
have blocked a tool call is audit-logged as `paused_allow` (`adapter:
"opencode"`, but with no accompanying stderr diagnostic the way
`PreToolUse` emits one -- the audit entry is the only observable
signal); a pause that changes nothing (a read-only tool, an
already-approved report) stays silent; a force-bypass under an active
pause keeps its own `force_bypass` audit kind rather than being folded
into `paused_allow`. This only covers opencode when
`UNDERSTANDING_GATE_PAUSE_FILE` is exported into the environment that
launches opencode (opencode has no per-hook-line settings.json
equivalent to wire it through, so it is read off the launching
process's env instead); unset there means no pause check on opencode at
all, even if the same variable is set for Claude Code's hooks.
