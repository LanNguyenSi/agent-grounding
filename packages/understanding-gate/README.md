# understanding-gate

Pre-execution gate for AI agent harnesses. Before an agent edits files, runs destructive commands, or opens PRs, this tool asks it to emit a structured Understanding Report so a human can confirm, correct, or "grill me" before execution begins.

> **Status:** Phase 2 (enforcement) shipped. Phases -1, 0, 0.5, 1, 2 are live: prompt-hook gate, structured report parsing + persistence, and tool-blocking until the report is approved. Phase 3 (agent-tasks lifecycle integration) is next. See [ROADMAP.md](./ROADMAP.md).

## What it does

The gate sits in front of your agent harness as **two layers**, intentionally separated so each does one job well:

**Layer 1, the cooperative gate (Phase 0).** A `UserPromptSubmit` hook injects an instruction into every task-like prompt asking the agent to first produce a report covering: current understanding, intended outcome, derived todos, acceptance criteria, assumptions, open questions, out-of-scope, risks, verification plan. A cooperative agent reads this and pauses for human confirmation. This is where most of the value comes from in practice: the agent slows down on its own and surfaces its interpretation before doing anything irreversible.

**Layer 2, the enforced backstop (Phase 2).** A `PreToolUse` hook blocks destructive tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` on Claude Code; `write`, `edit`, `bash` on opencode) until the latest persisted Understanding Report has `approvalStatus: "approved"`. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, …) stay open at all times. Every block, approve, revoke, and force-bypass lands in `.understanding-gate/audit.log`. This is what fires when an agent ignores Layer 1, whether because of an aggressive prompt ("don't ask, just do"), a prompt-injection attack, or a less-cooperative model.

Two modes for the cooperative layer:

| Mode | When | Shape |
|---|---|---|
| `fast_confirm` (default) | low-risk, small tasks | 5-line summary, "please confirm" |
| `grill_me` | ambiguous, risky, broad | 9-section report, "please grill me" |

Escalation to `grill_me`: set `UNDERSTANDING_GATE_MODE=grill_me`, or include `grill me` / `/grill` in the prompt. Only `grill_me` (and the equivalent `full` template) produces a parseable report that gets persisted to disk; `fast_confirm` stays in-conversation.

### When does the block actually fire?

Cooperative agent + cooperative prompt: rarely. The agent reads the Layer-1 template, emits its report, and waits for confirmation, so write tools never get attempted in the first place. The Layer-2 hook still runs on every tool call, but stays silent (read-only allowed; no audit entry).

Cooperative agent + aggressive prompt ("do it now, no waiting"): often. The agent may try to edit before the report cycle closes; Layer 2 then denies with a clear deny-reason and writes a `block` event to the audit log. The agent typically reads the deny-reason and falls back to producing the report.

Non-cooperative or prompt-injected agent: this is the case Layer 2 exists for. Every destructive tool call is denied as long as no approved report exists. The audit log is the trail you'll go back to in an incident review.

Force-bypass with `UNDERSTANDING_GATE_FORCE=1` + a 10-character `UNDERSTANDING_GATE_FORCE_REASON`: the only way through Layer 2 without an approved report. Both the bypass attempt and any attempt with a missing/short reason are audit-logged.

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

### Non-interactive sessions (`claude -p`)

Phase 2 works under `claude -p` as long as the harness ships
`last_assistant_message` in the Stop-hook payload (Claude Code 1.0+;
the 0.2.1 release added preference for this field to dodge a
transcript-flush race). For older harnesses the gate falls back to
reading the transcript JSONL, which can race against the harness's
flush timing. If your `.understanding-gate/reports/` stays empty
under a `-p` run while the agent's output clearly contains a
`# Understanding Report`, that race is the most likely cause; upgrade
the harness or run interactively as a workaround.

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

The CLI flips the persisted report's `approvalStatus` field, which is the source of truth the `PreToolUse` hook reads. Each approve / revoke also drops a JSONL line in `.understanding-gate/audit.log` (block, approve, revoke, force_bypass).

### Disable or force-bypass

```bash
# Kill switch (gate is off entirely):
UNDERSTANDING_GATE_DISABLE=1 claude

# Bypass enforcement once with a recorded reason (≥ 10 chars; logged):
UNDERSTANDING_GATE_FORCE=1 \
UNDERSTANDING_GATE_FORCE_REASON="incident-recovery for ticket 1234" \
claude
```

`FORCE` without a `FORCE_REASON` (or with one shorter than 10 chars) still blocks; the bypass is deliberately friction-bearing.

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
