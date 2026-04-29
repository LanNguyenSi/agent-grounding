# understanding-gate

Pre-execution gate for AI agent harnesses. Before an agent edits files, runs destructive commands, or opens PRs, this tool asks it to emit a structured Understanding Report so a human can confirm, correct, or "grill me" before execution begins.

> **Status:** Phase 0 in progress. Claude Code adapter + CLI ship in this phase; opencode adapter (v0.5) is the next phase. See [ROADMAP.md](./ROADMAP.md).

## What it does

Installs a prompt-hook into your agent harness (Claude Code, opencode). When the user submits a task-like prompt, the hook injects an instruction asking the agent to first produce a report covering: current understanding, intended outcome, derived todos, acceptance criteria, assumptions, open questions, out-of-scope, risks, verification plan.

In Phase 0 this is advisory: the agent can ignore the snippet and proceed. Phase 2 adds tool-blocking enforcement.

Two modes:

| Mode | When | Shape |
|---|---|---|
| `fast_confirm` (default) | low-risk, small tasks | 5-line summary, "please confirm" |
| `grill_me` | ambiguous, risky, broad | 9-section report, "please grill me" |

Escalation to `grill_me`: set `UNDERSTANDING_GATE_MODE=grill_me`, or include `grill me` / `/grill` in the prompt.

## Why this exists

Agentic systems often fail at the transition from partially-understood task to real-world action. The agent infers too much too early, executes on wrong assumptions, and the result is off-target. A pre-execution gate makes the interpretation visible and reviewable before the first impactful action.

This is the front-of-pipeline counterpart to `claim-gate` (no claims without evidence) and `review-claim-gate` (no merge without checklist). Same family, earlier checkpoint.

## Quickstart

### Claude Code (v0)

```bash
npx @lannguyensi/understanding-gate init --target claude-code
```

Writes a `UserPromptSubmit` hook entry into `.claude/settings.json` (project scope) or `~/.claude/settings.json` (`--scope user`). The hook only fires on task-like prompts (keyword classifier), so non-task questions are unaffected.

### opencode (v0.5)

```bash
npx @lannguyensi/understanding-gate init --target opencode
```

opencode has no per-prompt hook before model inference, so v0.5 falls back to a static rules file (`.opencode/rules/understanding-gate.md`) plus an explicit custom command (`.opencode/command/grill.md`). The agent always sees the fast-confirm rule; the user invokes `/grill` for the deeper challenge.

### Disable temporarily

```bash
UNDERSTANDING_GATE_DISABLE=1 claude
```

## What v0 does NOT do

- Block any tool. The Phase 0 gate is advisory; Phase 2 ships enforcement.
- Call an LLM. The task-like classifier is a deterministic keyword regex.
- Persist the agent's report. Phase 1 adds local persistence; Phase 3 syncs to `agent-tasks`.
- Auto-escalate to `grill_me` based on risk. Manual escalation only in v0.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Current phase: -1 (Foundation). Phase 0 ships the Claude Code adapter; Phase 0.5 ships the opencode adapter; Phase 1 parses and persists the report; Phase 2 adds tool-blocking enforcement; Phase 3 integrates with `agent-tasks` lifecycle states.

## Design docs

The concept and architecture live in the project log:

- `lava-ice-logs/2026-04-29/pre-execution-understanding-gate.md`
- `lava-ice-logs/2026-04-29/agent-harness-pre-execution-understanding-gate-architecture.md`

## Status

Experimental, pre-release. APIs may change between phases.
