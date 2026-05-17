# Changelog

## Unreleased

### Fixed: `understanding-gate --version` reads from package.json

- **`src/cli.ts` now sources `.version()` from `package.json` at runtime via `createRequire`.** Previously hardcoded `.version("0.2.3")` literal drifted past the 0.3.0 release because the bump touched `package.json` but not the CLI source, so installs on `@lannguyensi/understanding-gate@0.3.0` still reported `0.2.3` from `understanding-gate --version`. The functional 0.3.0 changes were always present in the installed dist; only the `--version` output was stale.
- **Why it matters.** `harness doctor` enforces `min_version` floors declared in hook manifests via `<bin> --version`. Without this fix, any harness floor at `>= 0.3.0` on the understanding-gate hooks false-positives on every install. The harness-side floor work (LanNguyenSi/harness task `6af1727f`) is queued blocked-by this fix shipping as 0.3.1+.
- **Regression test.** `tests/cli-version.test.ts` spawns `dist/cli.js --version` and asserts the output matches `package.json`. Prevents the literal from ever drifting again.

PR pending (agent-tasks `73092e5e`). Verified: 456/456 vitest, tsc + npm build clean, `node dist/cli.js --version` prints `0.3.0`.

## 0.3.0, 2026-05-16

### Feature: fast_confirm reports now persist end-to-end

- **Parser-side bullet-to-section mapping for fast_confirm mode.** The
  `fast_confirm` prompt emits five plain bullets with no
  `# Understanding Report` heading or 9-section structure that the
  parser required. PR #74 (0.2.3) made the silent failure observable
  via a `no_marker_fast_confirm_attempt` breadcrumb. This release
  closes the gap: `parseReport` now matches the five bullet prefixes
  (`I understood the task as:`, `I will do:`, `I will not touch:`,
  `I will verify by:`, `Assumptions:`) against the canonical section
  keys when `defaults.mode === "fast_confirm"` AND the section split
  returned zero headings. The existing 9-section walk still wins when
  canonical sections are present, so a fast_confirm agent that emits
  a full Report parses cleanly.
- **`UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM` variant.** New export
  alongside the strict `UNDERSTANDING_REPORT_SCHEMA`. Same properties
  block (so `minLength` / `minItems` still apply when an agent
  volunteers any dropped field), but drops `derivedTodos`,
  `acceptanceCriteria`, `openQuestions`, `risks` from `required`.
  Those four are the sections the fast_confirm prompt does not ask for.
  The validator is mode-aware: picks the relaxed schema when resolved
  `merged.mode === "fast_confirm"` (post-metadata-override).
- **Stop hook breadcrumb removed.** Both `REPORT_MARKER_RE` matches AND
  fast_confirm-bullet matches now route through `parseReport`. The
  existing `parse_error` log surface preserves observability for the
  subset where bullets reach the parser but still fail (e.g., wrong
  mode in env). Dead `PREVIEW_CHARS` constant removed.
- **Acceptance:** a fresh fast_confirm turn writes a saved report at
  `UNDERSTANDING_GATE_REPORT_DIR/<timestamp>-<taskId>-<hash>.json`
  with `mode: fast_confirm`, all five mapped sections populated, the
  four dropped sections absent (schema accepts).
- **Backwards compatibility.** A `mode: grill_me` parse of a strict
  9-section report is unchanged. A `mode: fast_confirm` parse of a
  strict 9-section report also succeeds (uses relaxed schema but
  properties match). A `mode: undefined` parse of five bullets still
  fails (no fast_confirm pre-seed since `isFastConfirm` is false).

PR #78 (agent-tasks `eaac8fe5-bab8-4053-b7bc-0f63d277aeb5`). Verified
end-to-end against the compiled Stop bin: 455/455 vitest, tsc + npm
build clean, all 3 CI gates green.

## 0.2.3, 2026-05-15

### Fixed: Observable breadcrumb for fast_confirm bullet-attempts

- **Stop hook now writes a `parse-errors/<stamp>-*.log` when the assistant
  emits a recognizable `fast_confirm` response without the `# Understanding
  Report` heading.** Before 0.2.3 the marker-mismatch path in
  `handle-stop.ts` short-circuited to `kind: "no_report"` silently, no
  `mkdir`, no log; operators were left with an empty `reports/` dir and
  no breadcrumb to trace back to the prompt/parser shape mismatch (the
  `fast_confirm` prompt template emits bullets only, the parser requires
  the `# Understanding Report` heading + 9 named sections).
- **Detection is heuristic + tight.** A new `looksLikeFastConfirmAttempt`
  helper counts matches against the five distinct bullet prefixes that
  `src/prompts/fast-confirm.ts` emits (`I understood the task as`,
  `I will do`, `I will not touch`, `I will verify by`, `Assumptions`).
  Threshold is 4-of-5: a natural-English reply like "I will do X / I will
  not touch Y / I will verify by Z" only hits 3 and stays silent, so the
  breadcrumb path doesn't flood `parse-errors/` on every casual turn.
- **`StopHookOutcome.no_report` gains an optional `logPath?: string`.**
  Backward-compatible: `stop.ts` only branches on `outcome.kind === "saved"`.
- **Tests:** +6 cases in `tests/claude-code-handle-stop.test.ts`
  (bullet-match breadcrumb, below-threshold non-match, mode forwarding,
  log-writer-throws degrade-to-silent, marker-match-wins-over-bullet-match,
  indented + mixed `-` / `*` / `+` marker variants). 450/450 vitest green.
- **Out of scope:** the underlying prompt/parser reconciliation that would
  let `fast_confirm` produce a saved report end-to-end is tracked as a
  separate follow-up (agent-tasks `eaac8fe5`); this release ships the
  observability fix only.

Refs PR #74.

## 0.2.2, 2026-05-03

### Fixed: Trim tool name before deny-list lookup

- **`decideEnforcement` now `.trim()`s the incoming `tool_name` before
  the write-tool deny-list lookup.** Previously the match was a
  strict `Set.has` against `CLAUDE_CODE_WRITE_TOOLS` /
  `OPENCODE_WRITE_TOOLS`, so a harness payload like `"Edit "` (trailing
  space) or `"Edit\n"` (trailing newline) silently fell through to the
  read-only allow path, bypassing the gate entirely. With the trim,
  every whitespace variant of a write tool now hits the same block
  decision as the canonical form.
- **Case-folding is intentionally NOT applied.** Claude Code uses
  PascalCase (`Edit`, `Write`), opencode uses lowercase (`edit`,
  `write`), and the per-adapter sets enforce that distinction on
  purpose. Folding cross-harness would mask a version/harness mismatch
  by treating `"edit"` against the Claude Code set as a write tool.
  The trim fix is whitespace-only.
- **Tests:** +5 cases covering whitespace variants for `Edit` plus
  explicit cross-adapter no-folding asserts in both directions
  (`tests/core/enforcement.test.ts`). 444/444 vitest green at release
  time (438 + 6 since v0.2.1).
- **Dogfood:** verified end-to-end against the published
  `understanding-gate-claude-pre-tool-use` hook binary with
  `tool_name` payloads `Edit`, `Edit `, `Edit\n`, `  Edit`, and `Read`
  (read-only control). All four `Edit` whitespace variants block with
  exit 2 and a `permissionDecision: deny` envelope; `Read` falls
  through silently with exit 0.

Refs PR #55.

## 0.2.1, 2026-05-02

### Fixed: Phase 2 dogfood polish

- **`grill_me` and `full` prompt templates now prescribe the parser's 9
  section headings AND the top-level `# Understanding Report` marker.**
  0.2.0's `grill_me` was prose-only and let the agent improvise
  subheadings (`**Task:**`, `**Assumptions I'm making:**`, …); the
  Stop-hook parser rejected the report with `missing_sections`, no
  file landed in `.understanding-gate/reports/`, and
  `understanding-gate approve` had nothing to flip, so the Phase-2
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
  Documents that the trailing-walk itself was always correct; the
  0.2.0 symptom was upstream in the template plus the harness flush race.
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
