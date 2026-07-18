# Log

<!-- Add new entries at the top, newest first. -->

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
