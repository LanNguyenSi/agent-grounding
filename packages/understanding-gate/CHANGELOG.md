# Changelog

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
