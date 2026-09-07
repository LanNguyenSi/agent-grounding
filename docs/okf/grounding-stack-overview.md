---
type: overview
title: The grounding stack — where to read, and how releases are split
description: Pointer doc — the root README already diagrams the whole stack; this entry adds the release topology (four version-locked packages under one root tag, eight independently-versioned ones) that the diagram does not show.
tags: [overview, monorepo, releases, versioning, pointer]
timestamp: 2026-09-07T11:29:10Z
sources:
  - README.md
  - CHANGELOG.md
  - package.json
  - packages/grounding-mcp/package.json
  - packages/grounding-mcp/src/assessment-index.ts
  - packages/grounding-mcp/src/assessment-server.ts
  - .github/workflows/ci.yml
  - scripts/check-grounding-mcp-pack.js
---

# The grounding stack — pointer and release topology

## Read this first

[../../README.md](../../README.md) contains a mermaid diagram of the whole
stack (`README.md:13-49#"helpers --> el"`) and a runnable evidence-ledger CLI demo. It is current and
deliberately NOT duplicated here: one copy, no drift. Per-package READMEs cover
each package's own surface.

The three small planner packages (`domain-router`, `debug-playbook-engine`,
`readme-first-resolver`) are self-contained and adequately covered by their own
READMEs; they have no bundle doc by design.

## What the diagram does not show: two release lanes

`CHANGELOG.md` (`CHANGELOG.md:9-30#"readme-first-resolver"`) records a split release topology that surprises
anyone who assumes one monorepo means one version:

**Version-locked, released together under a single root tag `vX.Y.Z`** (all at
`0.6.0` as of this verification):

- `@lannguyensi/grounding-wrapper`
- `@lannguyensi/evidence-ledger`
- `@lannguyensi/claim-gate`
- `@lannguyensi/hypothesis-tracker`

**Independently versioned, own tag and own CHANGELOG:**

- `@lannguyensi/understanding-gate` (tags `understanding-gate-vX.Y.Z`, published
  by `publish-understanding-gate.yml`, so its cadence never bumps the four
  locked packages)
- `@lannguyensi/grounding-mcp` (`0.11.0`)
- `@lannguyensi/runtime-reality-checker` (`0.3.2`)
- `@lannguyensi/review-claim-gate` (`0.1.6`)
- `@lannguyensi/grounding-sdk`, `@lannguyensi/debug-playbook-engine`,
  `@lannguyensi/domain-router`, `@lannguyensi/readme-first-resolver`

Consequences an agent gets wrong without this:

- Bumping one of the four locked packages means bumping all four; a PR that
  bumps only `claim-gate` breaks the lock invariant.
- A grounding-mcp change does NOT require a root-tag release, and vice versa.
- Version numbers across packages carry no relationship: `grounding-mcp@0.11.0`
  is not "newer than" `evidence-ledger@0.6.0` in any meaningful sense.

The root `package.json` is private (`agent-grounding`, workspaces `packages/*`);
`npm run build`/`test`/`typecheck` run `--workspaces`, with a `build:deps` order
that builds grounding-wrapper, evidence-ledger, claim-gate, hypothesis-tracker
and runtime-reality-checker before the rest.

Two test runners coexist: **vitest** (evidence-ledger, claim-gate,
hypothesis-tracker, grounding-mcp, grounding-sdk, review-claim-gate,
runtime-reality-checker, understanding-gate) and **jest** (grounding-wrapper,
debug-playbook-engine, domain-router, readme-first-resolver). Reach for the
runner the package actually uses before adding a test.

## Packaging verification (CI)

`grounding-mcp`'s runtime version read (see the release topology note above)
is checked against the packed artifact (the tarball `npm publish` would
upload) on every PR, not only by hand at release time: the `ci` job's
"grounding-mcp packed-tarball --version check" step
(`.github/workflows/ci.yml:430-455#"npm run check:grounding-mcp-pack"`) runs
`scripts/check-grounding-mcp-pack.js`, which packs the workspace package
together with its version-locked `@lannguyensi/*` sibling dependencies
(derived from grounding-mcp's own package.json, not a hardcoded list),
installs every tarball together with `--omit=dev` into one scratch consumer
directory outside the repo tree, and asserts the installed
`grounding-mcp --version` bin's output equals the grounding-mcp TARBALL's
own `package.json` version. Co-packing the siblings keeps a lockstep
release PR (which re-pins those siblings to a same-PR, not-yet-published
version) from failing this check with a registry ETARGET. Its own fixture,
argv-level, and end-to-end unit tests run in the following "grounding-mcp
packed-tarball --version checker unit tests" step
(`package.json:30#"test:check-grounding-mcp-pack"`); see
`docs/okf/log.md` for this check's history.

## Restricted producer entrypoint

The grounding-mcp package also has a separate `grounding-assessment-mcp` bin
(`packages/grounding-mcp/package.json:29-31#"dist/assessment-index.js"`).
Its composition root loads explicit issuer configuration and connects only
the assessment server to stdio
(`packages/grounding-mcp/src/assessment-index.ts:11-13#"StdioServerTransport"`).
That server registers the seven assessment lifecycle operations
(`packages/grounding-mcp/src/assessment-server.ts:32-35#"] as const);"`).
It uses the producer-owned assessment store, with no generic runtime, ledger,
or solution-verdict tools. It is part of the same package and release lane,
with separate startup configuration and deployment qualification. The package
[README](../../packages/grounding-mcp/README.md#restricted-assessment-mcp)
documents setup, byte transport, and consumer/activation boundaries.
