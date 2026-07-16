---
type: invariant
title: Hypothesis state — one library, two consumers, two persistence shapes
description: hypothesis-tracker is a pure in-memory library; grounding-mcp keeps a disk-backed LRU cache under ~/.grounding-mcp/hypotheses/ (since PR #139) while understanding-gate persists to hypotheses.json, and inside the library addEvidence and supportHypothesis disagree on whether required_checks gate promotion.
tags: [hypothesis-tracker, persistence, grounding-mcp, understanding-gate]
timestamp: 2026-07-16T02:31:52Z
sources:
  - packages/hypothesis-tracker/src/lib.ts
  - packages/grounding-mcp/src/hypothesis-store.ts
  - packages/grounding-mcp/src/server.ts
  - packages/understanding-gate/src/core/hypothesis-store-fs.ts
  - packages/understanding-gate/src/core/hypothesis-sync.ts
  - packages/understanding-gate/src/core/hypothesis-bridge.ts
---

# Hypothesis state: one library, two consumers, two persistence shapes

`@lannguyensi/hypothesis-tracker` is a **pure library with no persistence opinion**. It
owns the data shape (`Hypothesis`, `HypothesisStore`) and the mutators; *where the JSON
lives is entirely the consumer's call*. Both consumers now persist to disk, but in different
shapes: grounding-mcp keeps a disk-backed LRU cache keyed by session id, understanding-gate
keeps one file seeded from the Stop hook. A hypothesis survives a restart either way; the
difference is where it lands and how it is evicted, not whether it survives.

## Invariant 1 — the library never touches disk

`packages/hypothesis-tracker/src/lib.ts` is in-memory only. `createStore()` returns a plain
object `{ session, hypotheses: [] }` (lib.ts:46-48); every mutator (`addHypothesis`,
`addEvidence`, `completeCheck`, `rejectHypothesis`, `supportHypothesis`) mutates that object
in place. The only I/O-adjacent functions are `exportStore` (JSON string out, lib.ts:154)
and `importStore` (validated parse in, lib.ts:206) — neither reads or writes a file. A
coding agent must not assume calling a mutator persists anything.

### State machine — exactly three statuses

```
HypothesisStatus = "unverified" | "supported" | "rejected"   // lib.ts:9
```

There are only these three. New hypotheses start `"unverified"` (lib.ts:59). This union is
duplicated as a runtime guard in **two** other places, both of which will *silently drop
rows* if the union ever grows: `HYPOTHESIS_STATUSES` in lib.ts:158-162 (used by `importStore`)
and `VALID_STATUSES` in understanding-gate's `hypothesis-store-fs.ts:66` (explicitly
commented "If the upstream union grows, this guard will silently drop valid rows").

## Invariant 2 — TWO confirmation paths that disagree on required_checks (the trap)

Both promote a hypothesis to `"supported"`, but only one respects `required_checks`. Conflating
them is the central footgun.

- **`supportHypothesis(store, id)`** (lib.ts:125-132) — the *manual* confirm path. It
  **refuses** while any required check is pending:
  ```ts
  if (!hyp || hyp.status === "rejected") return null;
  if (hyp.required_checks.some((c) => !c.done)) return null;   // lib.ts:128 — the gate
  hyp.status = "supported";
  ```
  Returns `null` for unknown, already-rejected, **or checks-pending**. Evidence is
  intentionally NOT required here (it is the escape hatch for out-of-band evidence).

- **`addEvidence(store, id, text, source?)`** (lib.ts:75-91) — attaching the *first* piece of
  evidence **auto-promotes regardless of pending checks**:
  ```ts
  hyp.evidence.push({ text, source, addedAt: now() });
  if (hyp.status === "unverified") hyp.status = "supported";   // lib.ts:86-88 — no check gate
  ```

**The trap:** `required_checks` gate `supportHypothesis` but do **not** gate `addEvidence`.
An agent that thinks "checks must pass before a hypothesis can be supported" is wrong for the
evidence path — a single `addEvidence` call flips `unverified → supported` with every check
still `done: false`. This is by design (the tracker treats evidence attachment as itself a
form of support; see the doc-comment at lib.ts:115-124), not a bug, but it means the
"checks-drain-first" contract only holds for the manual verb.

## Consumer A — grounding-mcp: disk-backed LRU cache, survives restart

`packages/grounding-mcp/src/hypothesis-store.ts` backs an in-process
`Map<string, HypothesisStore>` (hypothesis-store.ts:65) with JSON files under
`~/.grounding-mcp/hypotheses/<sessionId>.json` (override via `GROUNDING_MCP_HYPOTHESES_DIR`,
`hypothesesRoot()` at hypothesis-store.ts:76-78). This replaced the tracker's original
volatile design (PR #139, 2026-07-13): the Map stays the hot path, but a cache miss (e.g.
right after a restart) hydrates from disk via `loadStoreFromDisk` (hypothesis-store.ts:132);
writers save via `saveStore` (atomic tmp+rename, hypothesis-store.ts:165-172), which
server.ts's `hypothesis_*` verbs call after every successful mutation (server.ts:391, :437,
:469, :491, :518). **A grounding-mcp process restart no longer loses hypothesis state** — it
now has disk backing at parity with the session store and the evidence ledger
(`packages/grounding-mcp/README.md:156`).

The in-process Map is LRU-bounded. `getMaxSessions()` (hypothesis-store.ts:190-196)
reads `GROUNDING_HYPOTHESIS_MAX_SESSIONS` lazily per call. **Default is `200`**; unset, empty,
non-integer (e.g. `"3.9"`), zero, or negative all fall back to `200`; the minimum honored cap
is `1`. On insert past the cap the least-recently-used key is evicted from the Map
(`cacheAndEvict`, hypothesis-store.ts:200-208); both reads (`getStore`) and writes
touch-reorder the key for true LRU recency. Because the disk file persists, **eviction is no
longer data loss**: the on-disk file for an evicted session is untouched and is re-hydrated on
the next `getStore`/`getOrCreateStore` call (hypothesis-store.ts:42-48 comment;
`loadStoreFromDisk` at :132), at the cost of one extra disk read, not the hypotheses
themselves.

### Hypothesis MCP tools (grounding-mcp `server.ts`)

Seven verbs, registered by name:

- `hypothesis_record` (server.ts:377) — add a competing hypothesis with required checks
- `hypothesis_list` (server.ts:397) — all hypotheses for a session + status summary
- `hypothesis_evidence` (server.ts:420) — attach evidence; **auto-promotes** (the `addEvidence` path above)
- `hypothesis_check_done` (server.ts:443) — mark a `required_checks[i]` done; drains `pending_checks`
- `hypothesis_reject` (server.ts:475) — reject with reason (appended as `[rejected]` evidence)
- `hypothesis_support` (server.ts:497) — explicit support; the checks-gated path; error
  `hypothesis_not_found_rejected_or_checks_pending` when it returns null (server.ts:513)
- `hypothesis_reset` (server.ts:524) — purge a session's hypotheses (MCP counterpart of `resetStore`), also deletes the on-disk file (hypothesis-store.ts:257-262)

Writers use `getOrCreateStore`; mutating verbs other than record require an existing store and
return `{ error: 'no_store_for_session' }` rather than creating one.

## Consumer B — understanding-gate: persisted, survives restart

`packages/understanding-gate/src/core/hypothesis-store-fs.ts` is a thin fs wrapper over the
same library. `loadOrCreateStore(path, session)` reads + validates JSON (dropping malformed
rows, counting them as `droppedCount`); `saveStore(path, store)` writes atomically via
`writeAtomicJSON`. **This state survives restarts.**

Exact path construction (`hypothesis-sync.ts:47`):
```ts
const storePath = resolve(opts.reportDir, "..", HYPOTHESES_STORE_FILENAME);
```
where `HYPOTHESES_STORE_FILENAME = "hypotheses.json"` (hypothesis-store-fs.ts:18) and
`opts.reportDir` is the directory the report was saved into (typically
`.understanding-gate/reports/`). The store therefore lands **one level up** from the report
dir, i.e. `.understanding-gate/hypotheses.json`, so dogfood inspection is
`cat .understanding-gate/hypotheses.json` (comment at hypothesis-store-fs.ts:6-8 and
hypothesis-sync.ts:31-36).

## Consumer B also *seeds* the store from the Stop hook

On the understanding-gate Stop-hook path, `syncHypothesesFromReport`
(`hypothesis-sync.ts:42-64`) loads the fs store and calls `registerReportHypotheses`
(`packages/understanding-gate/src/core/hypothesis-bridge.ts`), which walks the report and
registers each entry via the library's `addHypothesis`:

- `report.assumptions` → registered as kind `"assumption"` (hypothesis-bridge.ts:52-53)
- `report.openQuestions` → registered as kind `"open_question"` (hypothesis-bridge.ts:55-56)

It persists back only when something was added or corrupt rows were dropped
(hypothesis-sync.ts:52-53). It is best-effort and never throws. So an understanding report's
assumptions and open questions become durable hypotheses on disk — a side effect grounding-mcp
has no equivalent of.

## Bottom line for a reasoning agent

Same library, opposite guarantees:

| | Consumer A: grounding-mcp | Consumer B: understanding-gate |
|---|---|---|
| Backing store | in-process `Map`, disk-backed under `~/.grounding-mcp/hypotheses/<sessionId>.json` | `hypotheses.json` on disk, one level up from the report dir |
| Survives process restart? | **Yes** (since PR #139, 2026-07-13) | **Yes** |
| Eviction | LRU cap `GROUNDING_HYPOTHESIS_MAX_SESSIONS` (default 200); eviction drops only the in-process cache entry, the disk file is re-hydrated on next access | none (all rows retained; malformed dropped on load) |
| Seeded from reports? | no | yes (assumptions + open questions via Stop hook) |

Both consumers now survive a restart, so persistence is no longer the reason to prefer
one over the other; pick based on scope instead (grounding-mcp is per-session, understanding-gate
is per-run and seeded from the Stop-hook report). In either consumer, do not assume
`required_checks` gate promotion: they gate only `hypothesis_support` / `supportHypothesis`,
never `hypothesis_evidence` / `addEvidence`.
