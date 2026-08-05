# Log

<!-- Add new entries at the top, newest first. -->

- 2026-08-05T15:56:24Z, re-verification sweep (task d6f48ad9): 5 stale docs
  re-checked against current sources. Substantive: solution-acceptance-verdict-contract
  gained a new bullet for the Mixed-State-Bypass-Guard (task `8f173547`,
  `OW_FINDINGS_PLACEHOLDER_ROW` / `scanFindings` / `isPlaceholderRow` in
  ow-run-completeness.ts) and had every ow-run-completeness.ts line citation
  re-pinned — that file's header docstring and body grew substantially for the
  guard, shifting citations by anywhere from 0 to +78 lines (non-uniform, so each
  was re-derived by function name, not by a constant offset); solution-verdict.ts
  itself was untouched (all its citations still held exactly). grounding-stack-overview
  and claim-gate-vs-review-claim-gate had drifted version numbers (four locked
  packages 0.5.0 → 0.6.0, grounding-mcp 0.6.0 → 0.7.0, review-claim-gate
  0.1.3 → 0.1.5, review-claim-gate's pinned claim-gate/evidence-ledger deps
  0.5.0 → 0.6.0) — all ride-along re-pin bumps (PR #147/#148), no behavior
  change. evidence-ledger-session-key-shapes' db.ts line refs shifted +11
  (session column, rebuild copy, idx_session, listEntries filter, getSummary)
  from further db.ts churn since the 2026-07-18 getDb-guard re-stamp, plus one
  stale test-file line ref (grounding-gate-mcp-roundtrip.test.ts:645 → :632).
  hypothesis-tracker-persistence-split re-checked line-for-line against
  hypothesis-tracker/src/lib.ts, grounding-mcp's hypothesis-store.ts and
  server.ts hypothesis_* verbs, and understanding-gate's hypothesis-store-fs/
  -sync/-bridge — zero drift, restamp only. Checked PR #160/#161's
  `@modelcontextprotocol/sdk` 1.30.0 bump and lockfile-only audit fix against
  all 5 docs: no doc makes a claim it invalidates.

- 2026-07-18T05:08:08Z, ride-along re-verify (task 56e26999, getDb path
  guard): evidence-ledger-session-key-shapes re-stamped with db.ts line
  refs shifted +44 by the new singleton path guard (guard changes no
  session-key semantics); claim-gate-vs-review-claim-gate re-stamped
  unchanged (its db.ts claims — `listEntries(getDb(dbPath))` ledger
  fallback — still hold; the CLI's `resetDb()`-before-`getDb` hygiene
  predates the guard).

- 2026-07-16T02:31:52Z, re-verification sweep (task de7982e2): 5 stale docs re-checked
  against current sources. Substantive: grounding-mcp hypothesis state is
  disk-backed since PR #139 (doc premise inverted); review-claim-gate's
  evidence-path guard gained a symlink-aware backstop (PR #141); the
  `ledger add` example was corrected to the real `ledger fact` verb here
  and in merge-approval-gate-mechanics.md. claim-gate version bug
  541c19e8 confirmed fixed on master (PR #136).

- 2026-07-16T01:03:30Z, CI now watches staleness: warn-only
  `okf-kit check` on every PR (.github/workflows/okf-staleness.yml,
  canonical pattern from harness#350).
- 2026-07-10T01:54:48.122127Z, initial 7 docs authored and verified against sources at master
  20cf37f: grounding-stack-overview, runtime-reality-policy-pointer,
  evidence-ledger-session-key-shapes, solution-acceptance-verdict-contract,
  claim-gate-vs-review-claim-gate, hypothesis-tracker-persistence-split,
  merge-approval-gate-mechanics.
