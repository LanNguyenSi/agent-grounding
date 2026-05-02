# understanding-gate

Pre-execution gate for AI agent harnesses. Before an agent edits files, runs destructive commands, or opens PRs, this tool asks it to emit a structured Understanding Report so a human can confirm, correct, or "grill me" before execution begins.

> **Status:** Phase 2 (enforcement) shipped. Phases -1, 0, 0.5, 1, 2 are live: prompt-hook gate, structured report parsing + persistence, and tool-blocking until the report is approved. Phase 3 (agent-tasks lifecycle integration) is next. See [ROADMAP.md](./ROADMAP.md).

## What it does

Installs a prompt-hook into your agent harness (Claude Code, opencode). When the user submits a task-like prompt, the hook injects an instruction asking the agent to first produce a report covering: current understanding, intended outcome, derived todos, acceptance criteria, assumptions, open questions, out-of-scope, risks, verification plan.

Once the report is emitted and approved, the gate also _blocks_ destructive tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` on Claude Code; `write`, `edit`, `bash` on opencode) until the user runs `understanding-gate approve`. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, …) stay open at all times.

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

### Approve / revoke the gate

```bash
# After the agent emits a report you accept, in another terminal:
understanding-gate approve            # picks the latest report in cwd
understanding-gate approve --task-id <id>
understanding-gate approve --report-id <taskId|filename|path>

# Reverse it:
understanding-gate revoke

# Inspect:
understanding-gate status
```

The CLI flips the persisted report's `approvalStatus` field — that is the source of truth the `PreToolUse` hook reads. Each approve / revoke also drops a JSONL line in `.understanding-gate/audit.log` (block, approve, revoke, force_bypass).

### Disable or force-bypass

```bash
# Kill switch (gate is off entirely):
UNDERSTANDING_GATE_DISABLE=1 claude

# Bypass enforcement once with a recorded reason (≥ 10 chars; logged):
UNDERSTANDING_GATE_FORCE=1 \
UNDERSTANDING_GATE_FORCE_REASON="incident-recovery for ticket 1234" \
claude
```

`FORCE` without a `FORCE_REASON` (or with one shorter than 10 chars) still blocks — the bypass is deliberately friction-bearing.

## What v0 still does NOT do

- Call an LLM. The task-like classifier is a deterministic keyword regex.
- Sync approval state to `agent-tasks`. Phase 3 promotes the local marker to a first-class lifecycle state.
- Auto-escalate to `grill_me` based on risk. Manual escalation only in v0.
- Time-based expiry of approvals. An approved report stays approved until you revoke.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Phases -1 / 0 / 0.5 / 1 / 2 shipped: prompt-hook, structured report, persistence, hypothesis bridge, tool-blocking enforcement. Phase 3 is `agent-tasks` lifecycle integration.

## Design docs

The concept and architecture live in the project log:

- `lava-ice-logs/2026-04-29/pre-execution-understanding-gate.md`
- `lava-ice-logs/2026-04-29/agent-harness-pre-execution-understanding-gate-architecture.md`

## Status

Experimental, pre-release. APIs may change between phases.
