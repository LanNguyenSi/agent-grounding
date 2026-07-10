# Knowledge bundle index

Curated OKF knowledge bundle for agent-grounding: cross-file semantics,
invariants, and runbooks that no single package README states. The per-package
READMEs and `docs/` stay authoritative for their own surfaces; these docs point
at them rather than copying them.

## Overview

- [The grounding stack](grounding-stack-overview.md), pointer to the root
  README's architecture diagram, plus the release topology it does not show
  (four version-locked packages under one root tag, seven independent ones).
- [runtime-reality-checker as a policy](runtime-reality-policy-pointer.md),
  pointer to the authoritative spec, plus the ownership fact agents get
  backwards: this package interprets its own escalation env vars, harness only
  sets them.

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
- [Hypothesis state](hypothesis-tracker-persistence-split.md), one pure library,
  two consumers, opposite persistence guarantees, and two promotion paths that
  disagree about required_checks.

## Runbooks

- [Merge-approval gate](merge-approval-gate-mechanics.md), the five `review:*`
  labels, the branch-name key, when the check actually blocks, and how to
  re-trigger it.
