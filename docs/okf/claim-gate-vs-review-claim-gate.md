---
type: invariant
title: claim-gate vs review-claim-gate — same word, opposite trust models
description: Two sibling packages both gate on "evidence" but claim-gate trusts a caller-supplied boolean (self-discipline) while review-claim-gate reads a store (CI gate) — never treat them as interchangeable.
tags: [claim-gate, review-claim-gate, evidence, trust-boundary]
timestamp: 2026-07-18T05:08:08Z
sources:
  - packages/claim-gate/src/lib.ts
  - packages/claim-gate/src/cli.ts
  - packages/claim-gate/package.json
  - packages/review-claim-gate/src/lib.ts
  - packages/review-claim-gate/src/cli.ts
  - packages/review-claim-gate/README.md
  - packages/review-claim-gate/package.json
  - packages/evidence-ledger/src/db.ts
---

# claim-gate vs review-claim-gate — same word, opposite trust models

## Invariant

Both `@lannguyensi/claim-gate` and `@lannguyensi/review-claim-gate` gate on a
prerequisite spelled with the word *evidence*, and both return the same
`{ allowed, score, reasons, next_steps }` verdict shape. They are **not**
interchangeable. The word means two different things:

- **claim-gate** trusts its caller. Its `has_evidence` is a caller-supplied
  boolean it never cross-checks against any store. It is a *self-discipline*
  tool for a single agent reasoning about its own diagnosis.
- **review-claim-gate** distrusts its caller for one prerequisite:
  `evidence_logged` is derived by *reading a store* (a committed evidence file
  or the evidence-ledger DB). It is a *CI merge gate*.

Confusing the two — e.g. assuming claim-gate consults the ledger, or assuming
review-claim-gate's non-`evidence_logged` flags are verified — defeats the gate.

## claim-gate — trusts the caller (self-discipline)

- A *claim* is free text. `detectClaimType(claim)` regex-maps it to one of nine
  `ClaimType`s (`root_cause`, `architecture`, `security`, `network`,
  `configuration`, `process`, `availability`, `token`, `generic`);
  `--type` overrides (`packages/claim-gate/src/lib.ts:108`, `:122`).
- Each `ClaimType` has a `POLICIES` entry listing which `ClaimContext` boolean
  flags must be `true` (`packages/claim-gate/src/lib.ts:50`). `evaluateClaim`
  computes `missing = requires.filter(req => !context[req])`, `allowed = missing
  .length === 0`, and `score = round(satisfied/requires * 100)`
  (`:126`–`:138`).
- **`has_evidence` is a caller-supplied boolean.** It is a field of the
  `ClaimContext` interface at `packages/claim-gate/src/lib.ts:29`
  (`has_evidence?: boolean;`), set on the CLI purely from the `--evidence` flag
  (`packages/claim-gate/src/cli.ts:63`, `has_evidence: opts.evidence,`).
  Nothing verifies it.
- **It never touches the evidence ledger.** `grep -rni "ledger"
  packages/claim-gate/src/` returns **zero hits** (exit 1). claim-gate has no
  dependency on `@lannguyensi/evidence-ledger` (`packages/claim-gate/package
  .json` deps: only `chalk`, `commander`). There is no store to consult; the
  flag is the fact.
- CLI: `claim-gate check <claim> [--readme --process --config --health
  --evidence --alternatives --type <t> --json]`. On a blocked claim it prints
  missing prerequisites and **exits 1** (`packages/claim-gate/src/cli.ts:89`,
  `if (!result.allowed) process.exit(1);`); `policies` lists all policies.
- **Every input is agent-writable and therefore forgeable.** An agent can pass
  `--evidence` (or any flag) with no underlying work. That is by design: this is
  a discipline aid, not an authority. Do not wire it into a merge decision.

## review-claim-gate — verifies against a store (CI gate)

- The claim type is the single `merge_approval`. `MERGE_APPROVAL_PREREQS` has
  five keys: `tests_pass`, `review_checklist_complete`,
  `no_unresolved_review_comments`, `scope_matches_task`, `evidence_logged`
  (`packages/review-claim-gate/src/lib.ts:43`). All five must be true for
  `allowed` (`:82`).
- **`evidence_logged` is the one prerequisite backed by a store, not a bare
  flag.** `runCheck` resolves an evidence *source* with this precedence
  (`packages/review-claim-gate/src/cli.ts:248`–`:294`; README "Evidence source
  precedence"):
  1. **forced** — `--evidence-logged` sets `evidence_logged=true` unconditionally,
     bypassing any lookup (`runCheck`, `src/cli.ts:260`-`264`; `buildContext` then
   applies it at `src/cli.ts:209`-`219`).
  2. **committed file** — an explicit `--evidence-file <path>` (must exist, else
     throws) or the auto-detected convention path
     `./.agent-grounding/evidence/<task-id>.jsonl` under `process.cwd()`; counts
     non-blank, JSON-parseable lines (`countEvidenceFileLines`, `:178`-`195`). This is
     the higher-integrity signal — the reviewer committed it to the PR branch.
  3. **ledger** — fallback: `deriveEvidenceLogged` calls
     `listEntries(getDb(dbPath), { session: taskId })` and uses `.length`
     (`:197`–`:207`), reading the real evidence-ledger SQLite DB keyed by
     `session = <task-id>`.
  `evidence_logged` becomes `true` iff forced, or the resolved source yielded
  `> 0` entries.
- The `--task-id` used as the ledger session key and as the auto-detect file
  path is untrusted input; `defaultEvidenceFilePath` rejects empty/absolute/`..`
  task ids and Windows drive-relative prefixes (e.g. `C:foo`), then backstops with
  both a lexical resolved-path containment check and a symlink-aware
  (`realpathSync`) containment check, so a committed symlink inside the evidence
  dir cannot smuggle a read outside it
  (`packages/review-claim-gate/src/cli.ts:76`-`159`).
- CLI: `check` exits `0`/`1` on the verdict (`src/cli.ts:396`); `export` dumps
  ledger entries for a session to JSONL for committing; `describe` lists prereqs.
- **Still partly forgeable — know the residual trust.** The other four prereqs
  (`tests_pass` etc.) are plain caller flags, and `--evidence-logged` force-bypasses
  the store. Even the verified path reads an *agent-writable* store: an agent can
  run the `ledger` CLI (e.g. `ledger fact`) to add entries or commit a `.jsonl` file. review-claim-gate raises
  the bar (evidence must physically exist in a store) but does not make it
  unforgeable; treat the gate as advisory-grade, and pair it with the operator-set
  merge-approval labels for authority.

## Why two packages, not one ClaimType

review-claim-gate is a deliberate sibling, not a 10th claim-gate `ClaimType`, so
its CLI, evidence-ledger integration, and policy can evolve without churning
claim-gate's core policies (`packages/review-claim-gate/src/lib.ts:7`). It
mirrors claim-gate's verdict shape on purpose so existing parsers keep working
(`src/lib.ts:31`).

## Cross-reference

The ledger fallback (source 3) keys entries by `session = <task-id>`. If the
reviewer logged evidence under a *grounding session id* instead of the
branch/task id, `listEntries({ session: taskId })` returns 0 and a legitimately
logged entry is invisible to the gate — cured by
`review-claim-gate export --task-id <branch> --from-session <gs-id>`. See
[evidence-ledger-session-key-shapes.md](evidence-ledger-session-key-shapes.md)
for the full key-shape trap.

## Publish status

Both are configured for public npm publish (`publishConfig.access: "public"` in
each `package.json`):

- `@lannguyensi/claim-gate` — version **0.5.0** (`packages/claim-gate/package.json`).
- `@lannguyensi/review-claim-gate` — version **0.1.3**
  (`packages/review-claim-gate/package.json`), depending on
  `@lannguyensi/claim-gate@0.5.0` and `@lannguyensi/evidence-ledger@0.5.0`
  (pinned, exact).

(These are the declared package versions; the manifests are publish-configured
but this check does not confirm a live registry publish.)
