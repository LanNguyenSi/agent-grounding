# understanding-gate Roadmap

Phased delivery. Each phase ships independently and is reviewable in isolation. Later phases depend on artifacts from earlier ones; we do not pre-build interfaces for phases that have not run dogfood yet.

## Phases

| Phase | Goal | Components | Depends on |
|---|---|---|---|
| -1 Foundation | Anchor every follow-up task with shared docs | `README.md`, `ROADMAP.md`, `docs/architecture.md` | none |
| 0 Claude Code MVP | Working prompt-hook in Claude Code, fast-confirm default, task-like classifier | package scaffold, `core/{classifier,mode,prompts,schema}`, `adapters/claude-code/user-prompt-submit`, CLI `init --target claude-code`, dogfood | Phase -1 |
| 0.5 opencode | Same value for opencode users, accepting the no-per-prompt-hook limitation | `adapters/opencode/{rules,command}`, CLI `init --target opencode` | Phase 0 |
| 1 Structured output | Parse and persist the report; bridge to `hypothesis-tracker` | `core/parser`, `core/persistence`, claude-code `Stop`/`PostToolUse` hook, opencode `message.updated` plugin | Phase 0 (schema reused) |
| 2 Enforcement | Block write tools until approval marker exists | `adapters/claude-code/pre-tool-use`, opencode `tool.execute.before`, CLI `approve`/`revoke`/`status`, audit log | Phase 1 (report id needed for marker) |
| 3 agent-tasks integration | Promote local marker to a first-class lifecycle state | new states + endpoints in `agent-tasks`, `grounding-wrapper` consumes the report | Phase 2 stable |

## Task tracking

Tasks for every phase are filed in `agent-tasks` under the `agent-grounding` project. The 10 tasks for the full plan, externalRef pattern `ug-2026-04-29-<slug>`:

| Phase | externalRef slug |
|---|---|
| -1 | `phase-minus1-foundation` |
| 0 | `phase0-scaffold` |
| 0 | `phase0-core` |
| 0 | `phase0-claude-adapter` |
| 0 | `phase0-cli-init` |
| 0 | `phase0-dogfood` |
| 0.5 | `phase05-opencode` |
| 1 | `phase1-structured-output` |
| 2 | `phase2-enforcement` |
| 3 | `phase3-agent-tasks-integration` |

Phases 1, 2, 3 are filed as bundled tasks; they will be split into sub-tasks once the prior phase produces dogfood feedback.

## What we explicitly do not do yet

- LLM-based prompt classification. v0 uses a keyword regex. Determinism + zero per-prompt latency.
- Auto-escalation to `grill_me` based on risk heuristics. Manual escalation only in v0.
- Persistence of the report to `agent-tasks` backend before Phase 3.
- Tool-blocking before Phase 2. The v0 gate is non-blocking; the agent can ignore the snippet. Worse signal, but a real first step that gets us dogfood.

## Phase exit criteria

A phase is "done" when:

1. All its tasks are merged.
2. Dogfood evidence is attached to the closing PR (transcript, screenshot, or smoke command output).
3. Any rough edges discovered during dogfood are filed as new tasks before the phase task is closed (per repo memory: tool friction creates a task).

## Phase entry criteria for the next one

Before starting Phase N+1:

- Read the closing PR notes from Phase N.
- Confirm no follow-up task in Phase N is still HIGH priority.
- Re-read the architecture doc; if Phase N's findings invalidated assumptions, update it before claiming Phase N+1 work.
