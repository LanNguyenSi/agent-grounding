# Knowledge bundle index

Curated OKF knowledge bundle for agent-grounding: cross-file semantics,
invariants, and runbooks that no single package README states. The per-package
READMEs and `docs/` stay authoritative for their own surfaces; these docs point
at them rather than copying them.

## Overview

- [The grounding stack](grounding-stack-overview.md), pointer to the stack
  diagram in docs/architecture.md, plus the release topology it does not show
  (four version-locked packages under one root tag, eight independent ones).
- [runtime-reality-checker as a policy](runtime-reality-policy-pointer.md),
  pointer to the authoritative spec, plus the ownership fact agents get
  backwards: this package interprets its own escalation env vars; harness sets
  them, reads the probe command, and itself checks only `RUNTIME_REALITY_DISABLE`.

## Invariants

- [Evidence-ledger session keys](evidence-ledger-session-key-shapes.md), one
  opaque TEXT column, two conventions: grounding-mcp writes a `gs-*` id while
  the merge-approval CI check keys by the PR head branch name.
- [Solution-acceptance verdict contract](solution-acceptance-verdict-contract.md),
  why the HEAD-pinned verdict marker lives outside the agent-writable ledger,
  and what remains knowingly forgeable.
- [claim-gate vs review-claim-gate](claim-gate-vs-review-claim-gate.md), the
  same word "evidence" with opposite trust models: a caller-supplied boolean
  versus a store that is actually read.
- [Grounding receipt codec contract](grounding-receipt-contract.md), the
  portable documentary-assessment wire format, frozen policy digest, and
  boundary between a signature check and a task decision.
- [Hypothesis state](hypothesis-tracker-persistence-split.md), one pure library,
  two persisting consumers (plus grounding-sdk, in memory only), two persistence
  shapes, and two promotion paths that disagree about required_checks.
- [Grounding phase model and claim context](grounding-phase-model-and-claim-context.md),
  phases advance on the caller's word, a phase without steps is marked skipped,
  and the two hand-kept context derivations count skipped as checked.
- [understanding-gate trust model](understanding-gate-approval-trust-model.md),
  approval as one field on the latest report for the bound task id, trusted
  whoever wrote it, the inputs the write-tool hooks trust, and which outcomes
  are audited.

## Runbooks

- [Merge-approval gate](merge-approval-gate-mechanics.md), the five `review:*`
  labels (plus a data-driven pure-release label-free path), the branch-name
  key, when the check actually blocks, and how to re-trigger it.
