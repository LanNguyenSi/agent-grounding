---
type: overview
title: The grounding stack — where to read, and how releases are split
description: Pointer doc — the root README already diagrams the whole stack; this entry adds the release topology (four version-locked packages under one root tag, seven independently-versioned ones) that the diagram does not show.
tags: [overview, monorepo, releases, versioning, pointer]
timestamp: 2026-07-16T02:31:52Z
sources:
  - README.md
  - CHANGELOG.md
  - package.json
---

# The grounding stack — pointer and release topology

## Read this first

[../../README.md](../../README.md) contains a mermaid diagram of the whole
stack (lines 9-50) and a runnable evidence-ledger CLI demo. It is current and
deliberately NOT duplicated here: one copy, no drift. Per-package READMEs cover
each package's own surface.

The three small planner packages (`domain-router`, `debug-playbook-engine`,
`readme-first-resolver`) are self-contained and adequately covered by their own
READMEs; they have no bundle doc by design.

## What the diagram does not show: two release lanes

`CHANGELOG.md` (lines 9-30) records a split release topology that surprises
anyone who assumes one monorepo means one version:

**Version-locked, released together under a single root tag `vX.Y.Z`** (all at
`0.5.0` as of this verification):

- `@lannguyensi/grounding-wrapper`
- `@lannguyensi/evidence-ledger`
- `@lannguyensi/claim-gate`
- `@lannguyensi/hypothesis-tracker`

**Independently versioned, own tag and own CHANGELOG:**

- `@lannguyensi/understanding-gate` (tags `understanding-gate-vX.Y.Z`, published
  by `publish-understanding-gate.yml`, so its cadence never bumps the four
  locked packages)
- `@lannguyensi/grounding-mcp` (`0.6.0`)
- `@lannguyensi/runtime-reality-checker` (`0.3.0`)
- `@lannguyensi/review-claim-gate` (`0.1.3`)
- `@lannguyensi/grounding-sdk`, `@lannguyensi/debug-playbook-engine`,
  `@lannguyensi/domain-router`, `@lannguyensi/readme-first-resolver`

Consequences an agent gets wrong without this:

- Bumping one of the four locked packages means bumping all four; a PR that
  bumps only `claim-gate` breaks the lock invariant.
- A grounding-mcp change does NOT require a root-tag release, and vice versa.
- Version numbers across packages carry no relationship: `grounding-mcp@0.6.0`
  is not "newer than" `evidence-ledger@0.5.0` in any meaningful sense.

The root `package.json` is private (`agent-grounding`, workspaces `packages/*`);
`npm run build`/`test`/`typecheck` run `--workspaces`, with a `build:deps` order
that builds grounding-wrapper, evidence-ledger, claim-gate, hypothesis-tracker
and runtime-reality-checker before the rest.

Two test runners coexist: **vitest** (evidence-ledger, claim-gate,
hypothesis-tracker, grounding-mcp, grounding-sdk, review-claim-gate,
runtime-reality-checker, understanding-gate) and **jest** (grounding-wrapper,
debug-playbook-engine, domain-router, readme-first-resolver). Reach for the
runner the package actually uses before adding a test.
