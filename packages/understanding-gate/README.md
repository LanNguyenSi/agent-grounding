# understanding-gate

Pre-execution gate for AI agent harnesses.

## Overview

Before an agent edits files, runs destructive commands, or opens PRs, this tool asks it to emit a structured Understanding Report so a human can confirm, correct, or "grill me" before execution begins.

> **Status:** Phase 2 (enforcement) shipped. Phases -1, 0, 0.5, 1, 2 are live: prompt-hook gate, structured report parsing + persistence, and tool-blocking until the report is approved. Phase 3 (agent-tasks lifecycle integration) is next. See [ROADMAP.md](./ROADMAP.md).

The gate sits in front of your agent harness as **two layers**, intentionally separated so each does one job well:

**Layer 1, the cooperative gate (Phase 0).** A `UserPromptSubmit` hook injects an instruction into every task-like prompt asking the agent to first produce a report covering: current understanding, intended outcome, derived todos, acceptance criteria, assumptions, open questions, out-of-scope, risks, verification plan. A cooperative agent reads this and pauses for human confirmation. This is where most of the value comes from in practice: the agent slows down on its own and surfaces its interpretation before doing anything irreversible.

**Layer 2, the enforced backstop (Phase 2).** A `PreToolUse` hook blocks destructive tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` on Claude Code; `write`, `edit`, `bash` on opencode) until the latest persisted Understanding Report has `approvalStatus: "approved"`. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, ...) stay open at all times. Every block, approve, revoke, and force-bypass lands in `.understanding-gate/audit.log`. This is what fires when an agent ignores Layer 1, whether because of an aggressive prompt ("don't ask, just do"), a prompt-injection attack, or a less-cooperative model.

## Key features

- Two modes for the cooperative layer: `fast_confirm` (default, 5-line summary) and `grill_me` (9-section report, persisted to disk)
- Enforced backstop that blocks write/execute tools until a report is approved, with an audited force-bypass and an optional pause sentinel
- One-shot installers for Claude Code and opencode hooks
- Every block, approve, revoke, and force-bypass decision is JSONL-audited

This is the front-of-pipeline counterpart to `claim-gate` (no claims without evidence) and `review-claim-gate` (no merge without checklist). Same family, earlier checkpoint.

## Install / quick start

### Claude Code

```bash
npx @lannguyensi/understanding-gate init --target claude-code
```

Writes three hook entries into `.claude/settings.json` (project scope) or `~/.claude/settings.json` (`--scope user`): `UserPromptSubmit` (Layer-1 prompt template, Phase 0), `Stop` (parses the agent's final message and persists the report, Phase 1), and `PreToolUse` (Layer-2 enforcement, Phase 2). All three are installed in one shot. The `UserPromptSubmit` hook only fires on task-like prompts (keyword classifier), so non-task questions are unaffected. To remove the entries again, run `understanding-gate uninstall --target claude-code` (respects the same `--scope`).

### opencode (v0.5)

```bash
npx @lannguyensi/understanding-gate init --target opencode
```

opencode has no per-prompt hook before model inference, so v0.5 installs three files: `.opencode/rules/understanding-gate.md` (the static fast-confirm rule the agent always sees), `.opencode/command/grill.md` (the explicit `/grill` command), and `.opencode/plugins/understanding-gate-persist-report.ts` (a `message.updated` plugin shim that parses the agent's report and writes it to `.understanding-gate/reports/`; without this shim Phases 1 and 2 degrade silently). To remove the three files again, run `understanding-gate uninstall --target opencode`. See [opencode integration notes](docs/opencode-integration.md) for testing the plugin's failure path.

### Non-interactive sessions (`claude -p`)

Phase 2 works under `claude -p` as long as the harness ships `last_assistant_message` in the Stop-hook payload (recent Claude Code releases do). For older harnesses the gate falls back to reading the transcript JSONL, which can race against the harness's flush timing. If `.understanding-gate/reports/` stays empty under a `-p` run while the agent's output clearly contains a `# Understanding Report`, that race is the most likely cause; upgrade the harness or run interactively as a workaround.

## Usage

### Approve / revoke the gate

```bash
# After the agent emits a report you accept, in another terminal:
understanding-gate approve            # picks the latest report in cwd
understanding-gate approve --task-id <id>
understanding-gate approve --report-id <taskId|filename|path>

# Reverse it:
understanding-gate revoke

# Inspect:
understanding-gate status              # current approval state in cwd
understanding-gate report list         # all persisted reports
understanding-gate report show <id>    # one report (taskId, filename, or path)
```

The CLI flips the persisted report's `approvalStatus` field, which is the source of truth the `PreToolUse` hook reads. Each approve / revoke also drops a JSONL line in `.understanding-gate/audit.log` (block, approve, revoke, force_bypass).

### Disable or force-bypass

```bash
# Kill switch (gate is off entirely):
UNDERSTANDING_GATE_DISABLE=1 claude

# Bypass enforcement once with a recorded reason (>= 10 chars; logged):
UNDERSTANDING_GATE_FORCE=1 \
UNDERSTANDING_GATE_FORCE_REASON="incident-recovery for ticket 1234" \
claude
```

`FORCE` without a `FORCE_REASON` (or with one shorter than 10 chars) still blocks; the bypass is deliberately friction-bearing.

Escalation to `grill_me`: set `UNDERSTANDING_GATE_MODE=grill_me`, or include `grill me` / `/grill` in the prompt. Only `grill_me` (and the equivalent `full` template) produces a parseable report that gets persisted to disk; `fast_confirm` stays in-conversation.

## Documentation

- [When does the block actually fire?](docs/gate-behavior.md): what Layer 2 does for a cooperative agent, an aggressive prompt, and a non-cooperative or prompt-injected agent
- [Pause sentinel](docs/pause-sentinel.md): an optional, read-only mechanism to silence both hook layers on both Claude Code and opencode
- [opencode integration notes](docs/opencode-integration.md): testing the `transport_error` breadcrumb path
- [ROADMAP.md](./ROADMAP.md): phase status and what's next

## Not implemented yet

Phases -1, 0, 0.5, 1, 2 are live. The following items are deliberately out of scope for the current release; some are scheduled for later phases, some are deferred indefinitely:

- Call an LLM for prompt classification. The task-like classifier is a deterministic keyword regex. Determinism plus zero per-prompt latency.
- Sync approval state to `agent-tasks`. Phase 3 promotes the local marker to a first-class lifecycle state.
- Auto-escalate to `grill_me` based on risk heuristics. Manual escalation only for now.
- Time-based expiry of approvals. An approved report stays approved until you revoke.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT, experimental / pre-release. APIs may change between phases.
