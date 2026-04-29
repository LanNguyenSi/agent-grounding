# understanding-gate Architecture

Three-layer split: harness-agnostic Core, per-harness Adapters, the harnesses themselves. Core is pure. Adapters do I/O. Harnesses are external.

## Layered view

```
┌────────────────────────────────────────────────────────┐
│ Harness (external)                                     │
│  Claude Code            opencode                       │
│  UserPromptSubmit       rules + custom command (v0.5)  │
│  PreToolUse (Phase 2)   tool.execute.before (Phase 2)  │
└────────────┬──────────────────────────┬────────────────┘
             │ stdin/stdout JSON        │ in-process JS
             ▼                          ▼
┌────────────────────────────────────────────────────────┐
│ Adapter                                                │
│  adapters/claude-code   adapters/opencode              │
│  binary, exit codes     module, throw, output mutation │
└────────────┬───────────────────────────────────────────┘
             │ pure-function calls
             ▼
┌────────────────────────────────────────────────────────┐
│ Core (harness-agnostic, no I/O)                        │
│  classifier (isTaskLike)                               │
│  mode picker (fast_confirm | grill_me)                 │
│  prompt snippets (3 modes, bundled at build)           │
│  report schema (JSON Schema + TS types)                │
│  parser (Phase 1)                                      │
│  persistence (Phase 1, fs only)                        │
└────────────────────────────────────────────────────────┘
```

## Why this split

- Core has no harness dependency, so it is unit-testable without spawning processes or running TUIs.
- Adapters own the harness contract: stdin/stdout JSON for Claude Code, in-process JS for opencode. Different shapes, same Core.
- Adding a third harness (e.g. Cursor, Aider) is one new directory under `adapters/` plus one CLI `--target` value. Core never changes.

## Harness entry-points compared

| Capability | Claude Code | opencode |
|---|---|---|
| Per-prompt classification before model inference | `UserPromptSubmit` hook (child process, JSON stdin/stdout) | none. opencode has no event that fires on a fresh user message before inference. |
| Always-on instruction injection | `CLAUDE.md`, skills | `.opencode/rules/*.md` (AGENTS.md style) |
| Explicit user escalation | type a marker substring like `grill me` | `.opencode/command/grill.md` (custom command, user runs `/grill`) |
| Block write/edit tools (Phase 2) | `PreToolUse` hook, exit code 2 | `tool.execute.before` plugin, `throw` |

The asymmetry is the reason for the v0 / v0.5 split. Claude Code gets per-prompt classification; opencode falls back to always-on rule plus user-invoked command. Both feed the same Core.

## Composition with sibling packages

`understanding-gate` is the front-of-pipeline gate in the agent-grounding stack. Composition order at runtime, once Phase 1+ ships:

```
understanding-gate     ← agent must show interpretation before acting
  ↓
hypothesis-tracker     ← assumptions + open questions registered as hypotheses
  ↓
readme-first-resolver  ← agent must read primary docs before analysis
  ↓
claim-gate             ← agent cannot make strong claims without evidence
  ↓
evidence-ledger        ← evidence is recorded and queryable
  ↓
review-claim-gate      ← merge gate, fails closed unless tests + checklist + evidence
```

`grounding-wrapper` orchestrates this chain. A future Phase-3 PR will register `understanding-gate` with the wrapper so the chain enforces the order.

## Lifecycle states (relevant for Phase 3)

The full state model from the architecture design doc:

```
identified
  → analyzing_context        ← agent reads, no writes
  → understanding_drafted    ← agent has produced report
  → awaiting_human_confirmation
  → understanding_approved   ← Phase 2 unlocks write tools here
  → executing
  → implementation_done
  → review_requested
  → done
```

In Phase 0/0.5, these states are implicit (agent and user share a session). Phase 2 introduces a local marker file. Phase 3 promotes the marker to first-class states in `agent-tasks`.

## Configuration surfaces

| Surface | Phase | Purpose |
|---|---|---|
| ENV `UNDERSTANDING_GATE_MODE` | 0 | force `fast_confirm` or `grill_me` |
| ENV `UNDERSTANDING_GATE_DISABLE` | 0 | kill-switch, hook returns immediately |
| Prompt marker `grill me` / `/grill` | 0 / 0.5 | user-side mode escalation |
| ENV `UNDERSTANDING_GATE_REPORT_DIR` | 1 | override report persistence path |
| ENV `UNDERSTANDING_GATE_TASK_ID` | 1 | bind reports to a logical task identifier |
| ENV `UNDERSTANDING_GATE_FORCE` + `_FORCE_REASON` | 2 | bypass enforcement, requires reason ≥ 10 chars, audit-logged |
| ENV `AGENT_TASKS_TASK_ID` | 3 | sync reports to `agent-tasks` backend |

## Failure modes and defaults

The Phase-0 gate is non-blocking. Hook never crashes Claude Code: malformed input, missing binary, runtime error all degrade to "exit 0, empty stdout". The cost of a false-negative classification (gate skipped when it should fire) is acceptable; the cost of crashing the harness is not.

In Phase 2, blocking is enforced, but the kill-switch and force-bypass remain available. Both are audit-logged.
