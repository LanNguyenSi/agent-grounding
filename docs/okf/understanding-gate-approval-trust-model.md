---
type: invariant
title: "understanding-gate approval and enforcement: what the write-tool gate trusts"
description: Approval is the approvalStatus field of the latest persisted report for the bound task id; within this package only the approve and revoke CLI change it on an existing report (the persisting hooks save new reports as pending), the hooks do not check who wrote it, and harness's understanding-gate pack (v0.8.0 through v0.64.0) rewrites it too; the hooks trust their environment (kill switch first in the shared decision and unaudited, force-bypass audited), the unsigned pause sentinel, and the report directory, and the Claude Code and opencode adapters differ on degraded input.
tags: [understanding-gate, approval, enforcement, audit, trust-boundary]
timestamp: 2026-10-11T16:29:28Z
sources:
  - packages/understanding-gate/src/core/enforcement.ts
  - packages/understanding-gate/src/core/approval.ts
  - packages/understanding-gate/src/core/audit.ts
  - packages/understanding-gate/src/core/parser.ts
  - packages/understanding-gate/src/core/persistence.ts
  - packages/understanding-gate/src/adapters/claude-code/handle-pre-tool-use.ts
  - packages/understanding-gate/src/adapters/claude-code/handle-stop.ts
  - packages/understanding-gate/src/adapters/claude-code/pause.ts
  - packages/understanding-gate/src/adapters/opencode/persist-report.ts
  - packages/understanding-gate/src/adapters/opencode/persist-report-plugin.ts
  - packages/understanding-gate/src/cli/approve.ts
  - packages/understanding-gate/src/cli.ts
---

# understanding-gate approval and enforcement trust model

The package docs describe the gate's decision order
([gate-behavior.md](../../packages/understanding-gate/docs/gate-behavior.md))
and the pause sentinel
([pause-sentinel.md](../../packages/understanding-gate/docs/pause-sentinel.md)).
This doc collects what those decisions rest on: where approval comes from,
which task a report is bound to, which inputs are trusted without a check, and
which outcomes leave an audit line.

## Approval is one field of the latest report

There is no separate approval marker. The write-tool hooks read the
`approvalStatus` of the latest persisted Understanding Report for the active
task (`packages/understanding-gate/src/core/approval.ts:3#"approval.json marker file"`).

- Every report the agent emits is parsed with `approvalStatus` forced to
  `pending`, after all other fields are merged, so a `## Metadata` block cannot
  set it (`packages/understanding-gate/src/core/parser.ts:425-428#"approvalStatus:"`).
- Within this package only `withApprovalStatus` changes the field on an
  existing report, called by `approve` and `revoke`; the persisting hooks write
  new reports only as `pending`. Its actor type is `cli` or `force`; `force` is
  reserved and no call site uses it
  (`packages/understanding-gate/src/core/approval.ts:13-16#"export type ApproveActor ="`).
- The hooks check the field alone, not `approvedBy` or who wrote it
  (`packages/understanding-gate/src/core/approval.ts:32-33#"entry.approvalStatus ==="`).
  harness releases that ship its understanding-gate pack (v0.8.0 through
  v0.64.0; the opt-in auto-approval from v0.51.0) also rewrite the field to
  `approved` in the same report files, from `harness approve understanding` and
  from the pack's opt-in auto-approval;
  neither writes this package's `approve` audit line.
- `understanding-gate approve` and `revoke` load a report, flip the field with
  actor `cli` and save a new snapshot; the previous file stays in the report
  directory (`packages/understanding-gate/src/cli/approve.ts:46-68#"reportPath: saved.path,"`).
- "Latest" means the entry with the newest `approvedAt`, falling back to
  `createdAt`; a state flip refreshes `createdAt` so the new snapshot wins
  (`packages/understanding-gate/src/core/approval.ts:22-29#"return matches[0];"`).

Without `--task-id` or `--report-id`, the CLI approves only when every report in
the directory shares one task id; with several it refuses and asks for
`--task-id` (`packages/understanding-gate/src/cli/approve.ts:209-210#"pass --task-id <id> to disambiguate"`).

## Task binding

The persisting side and the enforcing side compute the task id with the same
expression, `UNDERSTANDING_GATE_TASK_ID`, falling back to the harness session
id:

- Claude Code Stop hook: `packages/understanding-gate/src/adapters/claude-code/handle-stop.ts:192#"boundTaskId: input.env.UNDERSTANDING_GATE_TASK_ID || input.sessionId,"`
- opencode report persistence: `packages/understanding-gate/src/adapters/opencode/persist-report.ts:98#"boundTaskId: input.env.UNDERSTANDING_GATE_TASK_ID || input.sessionId,"`
- Claude Code PreToolUse: `packages/understanding-gate/src/adapters/claude-code/handle-pre-tool-use.ts:145#"const taskId = env.UNDERSTANDING_GATE_TASK_ID || sessionId ||"`
- opencode `tool.execute.before`: `packages/understanding-gate/src/adapters/opencode/persist-report-plugin.ts:265#"const taskId = process.env.UNDERSTANDING_GATE_TASK_ID || sessionId ||"`

The bound id overrides a `taskid` the agent writes into the report
(`packages/understanding-gate/src/core/parser.ts:430-431#"= defaults.boundTaskId;"`),
so a report cannot be filed under another task's approval. An approval
therefore covers one task id: a new harness session without
`UNDERSTANDING_GATE_TASK_ID` starts with no report and is blocked again.

## What the hooks trust, and what they log

Both adapters call the same pure `decideEnforcement`
(`packages/understanding-gate/src/core/enforcement.ts:62-130#"Latest Understanding Report is approved."`),
then apply the pause sentinel to a block decision. Each input below is taken as
given; none is signed or cross-checked.

| Input | Who controls it | Effect | Audit entry |
|---|---|---|---|
| `UNDERSTANDING_GATE_DISABLE` truthy (`1`, `true`, `yes`, `on`) | hook process environment | allow every tool; checked first inside `decideEnforcement`, but both hooks list the report directory before calling it, and the Claude Code hook handles a malformed or tool-less payload before it (that path still writes `degraded_allow`) | none |
| tool name not in the adapter's write set | the harness payload | allow | none |
| `UNDERSTANDING_GATE_FORCE` with a reason of at least 10 characters | hook process environment | allow a write tool | `force_bypass` |
| `UNDERSTANDING_GATE_FORCE` with a missing or shorter reason | hook process environment | block a write tool | `block` |
| no report, or latest report not approved, for the task id | report directory (`UNDERSTANDING_GATE_REPORT_DIR` or `.understanding-gate/reports` under the cwd) | block a write tool | `block` |
| active pause sentinel over a block decision | file at `UNDERSTANDING_GATE_PAUSE_FILE` | allow | `paused_allow` |

The truthy values come from `isTruthyEnv`
(`packages/understanding-gate/src/core/enforcement.ts:138-141#"return v ==="`).
Of the environment overrides, only the kill switch leaves no audit line. An
approved allow is not logged either, so `audit.log` records approvals made
through this package's CLI, not every approval. The pause sentinel is unsigned; this package only reads it
(`packages/understanding-gate/src/adapters/claude-code/pause.ts:66-108#"return expires > Date.now();"`).
A persisted report carries no signature either, so approval is only as strong
as write access to the report directory, just as a pause is only as strong as
write access to the sentinel file.

Both adapters treat an unreadable report directory as an empty one, so write
tools are blocked rather than allowed
(`packages/understanding-gate/src/adapters/claude-code/handle-pre-tool-use.ts:147-155#"entries = [];"`,
`packages/understanding-gate/src/adapters/opencode/persist-report-plugin.ts:267-274#"entries = [];"`).

## Where the adapters differ

| | Claude Code `PreToolUse` | opencode `tool.execute.before` |
|---|---|---|
| Write set | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` | `write`, `edit`, `bash` |
| Block signal | deny envelope on stdout plus exit code 2 | thrown `Error` |
| Malformed payload or missing tool name | allow, stderr line, `degraded_allow` audit entry | an empty tool name is not in the write set, so a silent read-only allow |
| Paused override of a block | stderr line plus `paused_allow` | `paused_allow` only, no stderr |

Tool names are trimmed but not case-folded, so each adapter matches only its
own spelling (`packages/understanding-gate/src/core/enforcement.ts:71-80#"const normalizedTool = input.tool.trim();"`;
the sets are `packages/understanding-gate/src/core/enforcement.ts:45#"export const CLAUDE_CODE_WRITE_TOOLS"`
and `packages/understanding-gate/src/core/enforcement.ts:54#"export const OPENCODE_WRITE_TOOLS"`).
The Claude Code degraded paths are
`packages/understanding-gate/src/adapters/claude-code/handle-pre-tool-use.ts:104#"Malformed PreToolUse payload; gate degraded to allow."`
and `packages/understanding-gate/src/adapters/claude-code/handle-pre-tool-use.ts:126#"PreToolUse payload had no tool_name; nothing to gate."`;
the opencode path is
`packages/understanding-gate/src/adapters/opencode/persist-report-plugin.ts:259-357#"allow path (approved / readonly_tool / disabled): silent."`.

## The audit log

Entries are JSONL lines in `<cwd>/.understanding-gate/audit.log`
(`packages/understanding-gate/src/core/audit.ts:106-107#"return resolve(cwd,"`),
with the kinds `block`, `approve`, `revoke`, `force_bypass`, `paused_allow` and
`degraded_allow` (`packages/understanding-gate/src/core/audit.ts:28#"export type AuditEvent ="`).
The cwd differs by writer: the Claude Code hook uses the payload's `cwd`
unvalidated (`packages/understanding-gate/src/core/audit.ts:15#"(the cwd the harness reports) without validation."`),
the opencode plugin uses its project directory, and the approve CLI uses the
cwd it is run in, so approve and revoke lines land in the directory the
operator ran the command from. Every writer swallows audit-write failures; a
failed append never changes the decision. Read-only allows, approved allows and
kill-switch allows write nothing.
