---
type: invariant
title: Evidence-ledger session keys — one opaque column, two conventions
description: The ledger `session` is a single opaque TEXT column; grounding-mcp keys it by a generated `gs-*` id while the merge-approval CI Action keys it by the PR head branch name, so evidence written under one key is invisible to a reader expecting the other.
tags: [evidence-ledger, sessions, keys, ci, mcp]
timestamp: 2026-07-10T01:40:00.436303Z
sources:
  - packages/evidence-ledger/src/types.ts
  - packages/evidence-ledger/src/db.ts
  - packages/grounding-mcp/src/server.ts
  - packages/grounding-wrapper/src/lib.ts
  - packages/review-claim-gate/README.md
  - .github/workflows/merge-approval.yml
---

## The invariant

The evidence ledger stores who-owns-this-row in a single opaque column, `session TEXT NOT NULL DEFAULT 'default'`, defined once in the `entries` table (`packages/evidence-ledger/src/db.ts:105`, mirrored in the `entries_new` rebuild at `:135`). The schema draws no distinction between the two kinds of value that get written into it: a grounding/Claude session id and a PR-scoped task/branch id are the same type, indexed the same way (`idx_session`, `db.ts:110`). The read API is a plain equality match — `listEntries` filters `session = @session` (`db.ts:259-262`) and `getSummary(db, session = "default", …)` (`db.ts:303-314`) delegates straight to it. There is no fallback, no aliasing, no normalization: **a reader keyed by string X sees only rows whose `session` column equals X exactly.** Both writers and readers are therefore bound by an out-of-band naming convention, not by anything the schema enforces.

Two conventions exist, and they do not agree:

- **grounding-mcp keys by a generated `gs-*` id.** `ledger_add` documents its `sessionId` param as "Session id — used as the ledger session namespace" (`packages/grounding-mcp/src/server.ts:177`) and passes it verbatim as `session` into `addEntry` (`server.ts:184-190`). The id that flows through here is minted by `generateSessionId(keyword)` = `` `gs-${slug}-${ts}` `` (`packages/grounding-wrapper/src/lib.ts:58-61`), where `slug` is the keyword lowercased, non-alphanumerics collapsed to `-`, truncated to 16 chars, and `ts` is `Date.now().toString(36)`. Shape: `gs-<keyword-slug>-<base36-timestamp>` (e.g. `gs-agent-grounding-<ts>`).

- **The merge-approval CI Action keys by the PR head branch name.** `.github/workflows/merge-approval.yml:49` passes `task-id: ${{ github.event.pull_request.head.ref }}` into the `review-claim-gate/action`. `head.ref` is the **PR HEAD BRANCH NAME**, not a task UUID. This correction is load-bearing: any mental model that assumes CI reads evidence under a task UUID is wrong — it reads under the literal branch string.

`review-claim-gate` resolves evidence with a fixed precedence (`packages/review-claim-gate/README.md:69-73`): (1) `--evidence-logged` forces `evidence_logged=true`; (2) a **committed evidence file** — explicit `--evidence-file <path>`, else auto-detected at `./.agent-grounding/evidence/<task-id>.jsonl` relative to `process.cwd()`; (3) the local evidence-ledger DB keyed by `session = <task-id>` as the fallback. In the CI path `<task-id>` is that branch name. So the ledger fallback only ever finds rows a writer stored under the exact branch string.

**Consequence:** evidence a reviewer logged under a `gs-*` grounding session is invisible to a merge-approval reader looking under the branch name, and vice-versa. Nothing in the schema signals the mismatch — the query simply returns zero rows, which the gate reads as "no evidence logged."

The bridge is real. `review-claim-gate export --task-id <branch-name> --from-session <gs-id>` re-emits a grounding session's rows into an evidence file under the branch/task naming convention, so the reviewer avoids re-logging (`README.md:59-63`, `:75-78`; reviewer-template usage `:161`). Because export writes to the same auto-detect path the `check` step reads (`README.md:80`), the intended round-trip is **export → commit → check** (evidence-source `"file"`, not `"ledger"`).

A separate structural guard keeps decision rows from polluting evidence reads: `EntryType` makes `policy_decision` a first-class type alongside `fact`/`hypothesis`/`rejected`/`unknown` (`packages/evidence-ledger/src/types.ts:9-14`), and `getSummary` buckets it into its own `policyDecisions` array (`db.ts:320`), disjoint from the four evidence buckets. This is deliberate: the header comment (`types.ts:1-8`) records that harness's `filterEntriesByTag` was matching past `policy_decision:` payloads as substring hits for their own ledger tag; the dedicated bucket means a `policy_decision` row cannot contaminate a tag-substring evidence filter.

## Where it's enforced

- **Column + read API (the opaque key):** `packages/evidence-ledger/src/db.ts:105` (`session TEXT` def), `:135` (rebuild copy), `:259-262` (`listEntries` equality filter), `:303-322` (`getSummary`, including the `policy_decision` bucket split at `:320`).
- **Type bucket:** `packages/evidence-ledger/src/types.ts:9-14` (`EntryType`), `:41` (`policyDecisions` on `LedgerSummary`).
- **Writer convention (`gs-*`):** `packages/grounding-mcp/src/server.ts:177` (param doc), `:184-190` (write-through); id shape `packages/grounding-wrapper/src/lib.ts:58-61`.
- **CI reader convention (branch name):** `.github/workflows/merge-approval.yml:49` (`task-id: …head.ref`), consumed by the action pinned at `:47`.
- **Precedence + bridge:** `packages/review-claim-gate/README.md:69-73` (source precedence), `:75-80` (export bridge + round-trip), `:59-63` (export CLI signature).

## What breaks it

- **Assuming CI keys the ledger by a task UUID.** It keys by `head.ref`, the branch name. Log review evidence under the exact branch, or bridge it there with `export --task-id <branch> --from-session <gs-id>`, or the fallback finds nothing.
- **Logging under a `gs-*` session and expecting merge-approval to see it.** The two keys never coincide by accident (`gs-<slug>-<ts>` vs a branch name). Without the export bridge + a committed evidence file, `evidence_logged` reads false and the gate blocks.
- **Widening `getSummary`'s type filters** so `policy_decision` rows leak back into the evidence buckets — that reintroduces the exact substring-contamination bug the separate bucket was added to fix (`types.ts:1-8`).
- **Treating `session` matching as fuzzy.** It is strict SQL equality (`db.ts:261`). Case, hyphenation, and truncation of the `gs-*` slug are all significant; a near-miss returns zero rows silently.

## Out-of-repo boundary

The tag prefixes the harness gates consume — `preflight:<repo>`, `review-subagent:<id>`, `review:<id>`, `dogfood:<id>` — are **not defined anywhere in this repo.** Grep confirms zero occurrences as gate strings: `review-subagent` appears only in prose in `packages/review-claim-gate/README.md:137`; `dogfood:` appears nowhere in this repo; `preflight:` appears only incidentally inside a test description string (`packages/grounding-mcp/tests/grounding-gate-mcp-roundtrip.test.ts:645`). None of them is a gate string here. Note the distinct, unrelated `review:*` **PR labels** the merge-approval workflow reads (`review:tests-pass`, `review:checklist-complete`, `review:comments-resolved`, `review:scope-matches-task`, `review:evidence-logged`, `.github/workflows/merge-approval.yml:40-44`) — these are label names, not ledger tags, and are not the harness-owned `review:<id>` gate string. The harness gate prefixes are harness-owned; do not document them as an agent-grounding contract.

---
