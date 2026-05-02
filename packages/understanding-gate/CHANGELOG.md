# Changelog

## 0.2.1 — 2026-05-02

### Fixed — Phase 2 dogfood polish

- **`grill_me` and `full` prompt templates now prescribe the parser's 9
  section headings AND the top-level `# Understanding Report` marker.**
  0.2.0's `grill_me` was prose-only and let the agent improvise
  subheadings (`**Task:**`, `**Assumptions I'm making:**`, …); the
  Stop-hook parser rejected the report with `missing_sections`, no
  file landed in `.understanding-gate/reports/`, and
  `understanding-gate approve` had nothing to flip — the Phase-2
  approve flow couldn't close end-to-end. The new templates list
  `### 1. My current understanding` through `### 9. Verification plan`
  verbatim and tell the agent to begin with `# Understanding Report`
  on its own line so the marker regex matches reliably.
- **Stop hook prefers `payload.last_assistant_message` over the
  transcript file.** Newer Claude Code releases ship the final
  assistant text in the Stop payload directly. Reading it dodges a
  race where Stop fires before the transcript JSONL has been flushed
  (observed live under `claude -p`: persistence silently failed
  because the trailing-walk saw an empty file). Falls back to
  `extractLastAssistantText(transcript_path)` for older harnesses.
- **Roundtrip regression tests** (`tests/prompts.test.ts`): for both
  `FULL_PROMPT` and `GRILL_ME_PROMPT`, fill the template with
  placeholder bodies, run `parseReport`, assert success. Plus an
  explicit assertion that both templates instruct the agent to begin
  with the `# Understanding Report` marker.
- **Transcript test for the claude-`-p` preamble pattern**
  (`tests/claude-code-transcript.test.ts`): synthetic transcript with
  the report in turn 1 followed by tool_use boundaries before the
  final assistant text; `parseTrailingAssistantText` collects both.
  Documents that the trailing-walk itself was always correct — the
  0.2.0 symptom was upstream in the template + the harness flush race.
- **Stop binary test for the new `last_assistant_message` preference**
  (`tests/claude-code-stop-binary.test.ts`): payload-text wins even
  when the transcript file is empty; falls back cleanly when the
  field is omitted.

Dogfood evidence: clean approve → Edit succeeds → revoke → Edit blocks
cycle observed end-to-end against `claude -p` after the fix; audit
log captures `approve`, `revoke`, and `block` events with full
metadata.

## 0.2.0 — 2026-05-02

### Added — Phase 2 (enforcement)

- **`PreToolUse` hook for Claude Code** (`understanding-gate-claude-pre-tool-use`
  bin) blocks `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash` tool
  calls when the latest persisted Understanding Report for the active
  session is missing or has `approvalStatus !== "approved"`. Read-only
  tools (`Read`, `Grep`, `Glob`, `LS`, …) always pass.
- **opencode `tool.execute.before` hook** in the same plugin enforces the
  same rule for the lowercase `write` / `edit` / `bash` tools by throwing
  the deny reason back to the model.
- **`understanding-gate approve | revoke | status` CLI subcommands**.
  Approval is the persisted report file's `approvalStatus` field; the CLI
  loads the latest report (filtered by `--task-id`), flips the field, and
  saves a new snapshot. The original pending draft remains in the dir as
  audit trail.
- **`UNDERSTANDING_GATE_FORCE=1` + `UNDERSTANDING_GATE_FORCE_REASON`** for
  one-shot bypass. The reason must be ≥ 10 characters; otherwise the gate
  still blocks. Both bypass and block events land in
  `.understanding-gate/audit.log` (JSONL).
- **`UNDERSTANDING_GATE_DISABLE=1`** kill-switch (already supported by the
  earlier hooks) now also short-circuits enforcement.
- **`init` registers the new hook** alongside `UserPromptSubmit` and
  `Stop`; existing 0.1.x installs upgrade by re-running
  `understanding-gate init`.

### Changed

- `withApprovalStatus` (and therefore `approve` / `revoke`) refreshes
  `createdAt` on every state flip so the latest snapshot wins
  `findLatestForTask`'s sort. The previous snapshot is kept in the dir;
  the authoritative timeline of state changes is the JSONL audit log.

### Failure-mode posture

The gate still degrades to "allow + silent" on malformed hook input,
listReports failures, audit-log write failures, or any other unexpected
runtime error. Enforcement is enforced on the happy path and never
turns into a tarpit on the sad path.

## 0.1.1 — 2026-05-01

### Fixed

- **`bin` targets now ship executable**. 0.1.0 packed `dist/cli.js`,
  `dist/adapters/claude-code/user-prompt-submit.js`, and
  `dist/adapters/claude-code/stop.js` without the `+x` bit because
  `tsc` doesn't preserve executable mode on output. Result: a fresh
  `npm i -g @lannguyensi/understanding-gate` produced bin symlinks
  pointing to non-executable files, and Claude Code's `UserPromptSubmit`
  hook fired
  `/bin/sh: 1: understanding-gate-claude-hook: Permission denied`
  on every prompt. The shebangs were always there; the modes weren't.
- `build` now `chmod +x`'s the three bin targets so the pack tarball
  carries the correct mode and `npm i` lands them executable. Added
  `prepublishOnly: npm run build` so a publish without a fresh build
  still gets the chmod.

Reported via the agent-tasks board (`754798c6`); reproduced live during
a Claude Code session against `0.1.0`.

## 0.1.0 — 2026-05-01

First public release. Implements Phases -1 through 1 of the
[ROADMAP](./ROADMAP.md), plus the Phase 1 robustness, observability,
and ergonomics follow-ups.

### Highlights

- **Claude Code MVP (Phase 0)**: keyword-based prompt classifier,
  `UserPromptSubmit` hook that prepends a fast-confirm or grill-me
  prompt before the agent acts, ENV/marker mode resolution.
- **opencode adapter (Phase 0.5)**: rules + `/grill-me` custom command,
  `init --target opencode` writes a project- or user-scope shim.
- **Structured output (Phase 1)**: Markdown → validated
  `UnderstandingReport` parser, atomic local persistence with
  content-hash-keyed idempotency, claude-code `Stop` hook and opencode
  `message.updated` plugin that auto-persist the report,
  hypothesis-tracker bridge that registers assumptions / open questions.

### Robustness + observability

- Shared `writeAtomic` helper covers every fs-writing site in the
  package; cross-process concurrency test pins the no-torn-files
  invariant.
- Per-entry validation in `loadOrCreateStore` drops corrupt hypothesis
  rows silently and counts them; the cleaned store is rewritten on the
  next sync so bad rows do not linger.
- `UNDERSTANDING_REPORT_SCHEMA` rejects empty-string array items
  everywhere and empty arrays for the three list fields the gate's
  value depends on.
- Hypothesis-sync errors land in `<reportRoot>/sync-errors/` instead
  of being silently discarded.
- opencode transport failures (rejected promise OR resolved-with-error
  envelope) drop a `transport_error` JSON breadcrumb under
  `parse-errors/` so dogfood can see what went wrong.
- Marker regex tightened: bare `grill me` only fires at strong
  boundaries so prompts that mention the marker in passing no longer
  escalate; slash form `/grill` stays loose.

### Internals

- `KEY_ORDER` derived from the schema's `properties` order so a future
  field cannot be silently stripped from persisted reports.
- Saved-report filenames carry an 8-char sha256 prefix
  (`<iso>-<slug>-<hash>.json`); idempotency check is filename-only.
- runInit / runUninstall lost the `commandName` override (was UPS-only,
  asymmetric, unused).

### Tests

328 vitest cases including end-to-end binary tests for both the
claude-code Stop hook and the opencode plugin.
