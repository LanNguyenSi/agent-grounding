# Phase 0 Dogfood

Manual end-to-end verification of the understanding-gate Phase 0 deliverables (scaffold, core, claude-code adapter, CLI) against the real `~/.claude/settings.json` on a working dev box. Recorded 2026-04-29 after PRs #21, #22, #23, #24, #25 merged.

Per repo memory `feedback_release_dogfood`: smoke tests against the live system are required before declaring a phase complete; tests alone are insufficient proof for a hook system.

## Scope of this dogfood

What this transcript captures:

- The hook **binary** runs correctly when invoked as Claude Code would invoke it (stdin JSON, stdout JSON or empty).
- The **CLI** wires the binary into the real settings.json without breaking the existing memory-router entry.
- The **kill-switch** ENV works.
- The **defensive paths** (null, garbage JSON) silently no-op as designed.
- The **memory-router** (sibling hook) still fires after our entry is added.
- The **README quickstart** is a copy-paste path on a fresh project.

What this transcript does NOT capture, and is left to a fresh interactive Claude Code session:

- The agent's behavioral response to the injected snippet (does the model actually produce an Understanding Report?). This requires opening a new Claude Code session after the hook is installed; it cannot be observed from inside the same session that installed the hook, because hooks are loaded at session start.

The follow-up Phase 0 dogfood action is therefore: open a fresh Claude Code session, type the four golden prompts (Cases 1-4 below), and confirm the agent emits the Understanding Report shape. The wiring tested here proves the hook binary delivers the snippet to Claude Code; the agent-side observation is what closes the full loop.

## Setup

```
cd ~/git/pandora/agent-grounding
git checkout master && git pull --ff-only
cd packages/understanding-gate
npm run build
npm link              # makes understanding-gate + understanding-gate-claude-hook available on PATH
```

Verified bins on PATH:

```
$ which understanding-gate understanding-gate-claude-hook
/home/lan/.nvm/versions/node/v22.22.0/bin/understanding-gate
/home/lan/.nvm/versions/node/v22.22.0/bin/understanding-gate-claude-hook
$ understanding-gate --version
0.1.0
```

## Install into user settings.json

Settings backup taken before the install: `/tmp/ug-dogfood-settings-backup.json`. The pre-install state had a single memory-router UserPromptSubmit hook plus a memory-router PreToolUse hook.

```
$ understanding-gate init --scope user
understanding-gate: wrote hook entry to /home/lan/.claude/settings.json
next: try a prompt like "add a logout button to src/Header.tsx"
disable temporarily with: UNDERSTANDING_GATE_DISABLE=1 claude
```

Resulting `hooks.UserPromptSubmit` (memory-router preserved, our entry appended):

```json
{
  "UserPromptSubmit": [
    {
      "matcher": "",
      "hooks": [
        { "type": "command", "command": "memory-router-user-prompt-submit" }
      ]
    },
    {
      "matcher": "",
      "hooks": [
        { "type": "command", "command": "understanding-gate-claude-hook" }
      ]
    }
  ],
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "memory-router-pre-tool-use" }
      ]
    }
  ]
}
```

Idempotency check:

```
$ understanding-gate init --scope user
understanding-gate: /home/lan/.claude/settings.json already has the hook entry; nothing to do.
```

## Six golden cases via the linked binary

### Case 1: Positive task-like

```
$ echo '{"prompt":"add a logout button to the header in src/Header.tsx"}' \
    | understanding-gate-claude-hook | jq -c '.hookSpecificOutput | {hookEventName, mode: (.additionalContext | match("mode=\"([^\"]+)\"") | .captures[0].string), preview: (.additionalContext[0:120] + "...")}'
{"hookEventName":"UserPromptSubmit","mode":"fast_confirm","preview":"<understanding-gate mode=\"fast_confirm\">\n# Fast Confirm Mode\n\nBefore executing, provide a short confirmation summary:\n\n-..."}
```

Pass: emits hookSpecificOutput JSON with the fast_confirm snippet wrapped in the gate tags.

### Case 2: Negative non-task

```
$ echo '{"prompt":"what does jq -r do?"}' | understanding-gate-claude-hook
$ # exit 0, empty stdout
```

Pass: classifier rejected the prompt, no injection.

### Case 3: Manual grill escalation

```
$ echo '{"prompt":"grill me: refactor the auth module"}' | understanding-gate-claude-hook | jq -c '.hookSpecificOutput | {mode: ..., endsWith: (.additionalContext[-80:])}'
{"mode":"grill_me","endsWith":"g, too vague, too broad, or risky in this interpretation?\"\n</understanding-gate>"}
```

Pass: mode upgraded to grill_me, snippet ends with the expected challenge prompt.

### Case 4: Kill-switch ENV

```
$ echo '{"prompt":"add a button to App.tsx"}' | UNDERSTANDING_GATE_DISABLE=1 understanding-gate-claude-hook
$ # exit 0, empty stdout
```

Pass: kill-switch suppresses output even on a task-like prompt.

### Case 5: Defensive null payload

```
$ printf 'null' | understanding-gate-claude-hook
$ # exit 0, empty stdout, NO stderr
```

Pass: the null-payload TypeError discovered during PR #24 review stays fixed.

### Case 6: Defensive garbage JSON

```
$ printf 'garbage{{{' | understanding-gate-claude-hook
$ # exit 0, empty stdout
```

Pass: parse failure degrades silently.

## Memory-router regression check

Per repo memory `feedback_memory_router_dogfood`, the canonical positive/negative pair must keep working after our hook is added.

Negative (no memory should match):

```
$ echo '{"prompt":"rename this variable to fooBar"}' \
    | MEMORY_ROUTER_DIR=/home/lan/.claude/projects/-home-lan-git-pandora/memory \
      memory-router-user-prompt-submit
$ # empty stdout, exit 0
```

Positive (memories on the agent-tasks topic should match):

```
$ echo '{"prompt":"how does the agent-tasks PR merge work?"}' \
    | MEMORY_ROUTER_DIR=/home/lan/.claude/projects/-home-lan-git-pandora/memory \
      memory-router-user-prompt-submit | head -c 90
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"**memo
```

Pass: memory-router still fires for matching prompts.

## Fresh-user quickstart simulation

Verified the README quickstart copy-paste path works in a fresh project directory:

```
$ T=$(mktemp -d) && cd $T
$ understanding-gate init --target claude-code
understanding-gate: wrote hook entry to /tmp/tmp.bKvnr65XAz/.claude/settings.json
$ jq '.hooks.UserPromptSubmit[0].hooks[0].command' .claude/settings.json
"understanding-gate-claude-hook"
$ understanding-gate uninstall --target claude-code
understanding-gate: removed hook entry from /tmp/tmp.bKvnr65XAz/.claude/settings.json
$ cat .claude/settings.json
{}
```

Pass: install + uninstall round-trip leaves the file in `{}` state.

## Acceptance summary

| Acceptance criterion | Status |
|---|---|
| All four golden cases reproduce as described | Cases 1-4 ✅; agent-side observation deferred to fresh CC session |
| README quickstart works for a fresh user (run from /tmp) | ✅ |
| No regressions in unrelated existing hooks (memory-router still fires) | ✅ |
| If a rough edge is found, follow-up filed BEFORE merge | None found in this dogfood |

## Rough edges noted

None during this dogfood pass. Three nice-to-haves carried over from the PR #25 review (already documented there as non-blockers, file separately if desired):

1. README internal phase-line drift (`README.md:61` still says "Current phase: -1 (Foundation)").
2. Non-atomic settings.json writes (temp-then-rename for v2 hardening).
3. Type-shape rejection branch in `init.ts` is not directly exercised by a test (only the JSON.parse failure path is).
