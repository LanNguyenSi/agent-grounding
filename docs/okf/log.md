# Log

<!-- Add new entries at the top, newest first. -->

- 2026-08-19T10:38:21Z, restamp (task 9b6c4beb, round-2 review fix G2 of
  `.ai/runs/2026-08-19-verdict-signing-producer`): closes R2-M1 (round-2
  review finding: the prior restamp below was correct for commit `2db3098`,
  but the very fix commit that landed it, `c4a89d9`, immediately made it
  stale again by growing `writeVerdict`'s docblock with the new F6/D-006
  stale-marker-on-signing-failure paragraph, and separately regressed the
  `EvaluateResult` docblock the same commit touched). All 38
  `solution-verdict.ts`/`verdict-signing.ts` line citations in this doc were
  individually re-resolved against the current file (grep the cited symbol,
  confirm it sits at the cited line; not a constant-offset guess) and 38
  needed correcting; 25 others (8 into `solution-verdict.ts`/`server.ts`
  whose citations sit before every shift, 17 into the untouched
  `ow-run-completeness.ts`) were re-checked and confirmed still exact,
  no edit needed. Two shift bands account for the movement:
  `solution-verdict.ts` citations at/after `writeVerdict` (line 182, was
  155) shifted +27 (a +1 from the `Verdict.alg` docblock rewording below,
  landed by this same task's round-2 fix G3, then +26 more from
  `writeVerdict`'s new docblock paragraph); `verdict-signing.ts` citations
  at/after the D-001 comment (line 10) shifted +2 (D-001/D-005 provenance
  text reworded away from the `.ai/runs/...` path per F3, same as this doc's
  own prior sweep already did). The "7-key shape is pinned by the harness
  consumer" citation (`lines 536-537`, echo `line 602`) also moved content,
  not just position: round-2 fix G3 reworded both the `evaluateSolution`
  docblock paragraph and its inline echo to state precisely what they now
  mean (the OW arm adds no field of its own; the *returned* `verdict` stays
  pre-signing, `writeVerdict`'s `alg`/`signature` addition is separate and
  applies only to the on-disk marker) after a round-2 finding (R2-L1) that
  the old wording still read as "the whole marker is pinned to 7 keys",
  contradicting the `alg`/`signature` fields two sections above; this doc's
  citation now points at the reworded text (`lines 562-563`, echo
  `lines 631-632`), which still supports the same claim this doc makes.
  `okf-kit check --json docs/okf` (v0.4.0) re-run against the updated
  bundle: exit 0, 0 errors, warnings/notices unchanged from the prior sweep
  below (same 9 pre-existing `sources-fresh` staleness warnings in the 5
  OTHER docs untouched by this task; `solution-acceptance-verdict-contract.md`
  itself produced zero findings, same as before).

- 2026-08-19T09:24:20Z, re-verification sweep + new section (task 9b6c4beb,
  T-003 of `.ai/runs/2026-08-19-verdict-signing-producer`):
  solution-acceptance-verdict-contract re-checked line-for-line against
  grounding-mcp 0.8.0 (`packages/grounding-mcp` bumped 0.7.1 -> 0.8.0 in the
  same change). Substantive: new "Verdict marker signing (0.8.0)" section
  documents `src/verdict-signing.ts` (new file, T-001): the key path
  `<harness-home>/harness.generated/.approval-signing.key`, the mirrored
  3-tier-plus-create `resolveHarnessHome()` precedence, `getOrCreateSigningKey`
  (getOrCreate/0600/`wx`/truncated-key-repair), the fixed-order
  `canonicalPayload`/`signVerdict` payload, and D-001's independent-mirror /
  no-package-dependency rationale, plus a corrected account of the harness
  consumer's "genuinely unsigned, not forged" carve-out (T-002 finding: it is
  narrower than an earlier plan paraphrase; it fires only when a required
  signed field reads blank AND `alg`+`signature` are BOTH absent; a realistic
  pre-0.8.0 legacy marker, valid `timestamp`/`source` with no `alg`/`signature`
  at all, does NOT hit it and is classified `forged: true`), proven by the new
  `tests/interop/` suite (T-002, vendored source-stamped mirror of the harness
  consumer). The stale `PACKAGE_VERSION = '0.7.0'` citation is corrected to
  `0.8.0`; the "7 keys, pinned" verdict-shape section now also documents the
  two additive optional `alg`/`signature` fields; the "Hand-writing the
  marker" and "Out-of-repo boundary note" sections are updated to describe
  what 0.8.0 signing does and does not close (same-UID threat model,
  unchanged from harness' own posture, not a new authorization boundary).
  Restamp-only (line citations re-derived, no semantic change): every other
  `solution-verdict.ts` citation shifted, non-uniformly (+9 to +21 lines),
  because the `Verdict` interface grew from 16 to 27 lines to fit the two new
  fields and their doc comments, and `src/verdict-signing.ts` gained a new
  import line; `evaluateSolution` 523->544, `evaluateGate`'s HEAD-mismatch
  block 204-211->225-232, `writeVerdict`'s unconditional-overwrite line
  135->159, `verdictDir()` 91-98->103-110, `sanitizeVerdictId` 106-113->
  118-125, `verdictPath` 115->127, `owBlockersFor` 282->303, the
  `ready = pf.ready && ...` fold-in 584-586->601-607, the
  `orchestrator-workflow: ` prefix line 296->317, `owBindingBlockers`
  340-389->361-410, `RUN_BASE_SHA` 303->324, the legacy date-heuristic block
  380-388->401-409, `resolveOwKnob` 250-260->271-281, and the pre-merge-by-
  design test-pin comment 332-338->353-360; each was re-derived by grepping
  the current file for the named symbol, not by a constant offset. Citations
  into `ow-run-completeness.ts` and `session-store.ts` were left untouched
  (verified via `git log` that neither file has changed since the 2026-08-05
  sweep below, so their prior re-verification still holds); `README.md` was
  out of this task's allowed-changes scope and was not re-verified or edited
  here: its solution-acceptance-gate paragraph still describes the
  hand-write residual as fully open, which the new signing section above
  narrows; flagged as a follow-up, not fixed in this pass. `okf-kit check
  --json docs/okf` (v0.4.0) run against the updated bundle: exit 0, 0 errors,
  9 warnings, 0 notices, all pre-existing `sources-fresh`
  staleness in 5 OTHER docs (claim-gate-vs-review-claim-gate.md,
  evidence-ledger-session-key-shapes.md, grounding-stack-overview.md,
  hypothesis-tracker-persistence-split.md, merge-approval-gate-mechanics.md)
  untouched by this task; solution-acceptance-verdict-contract.md itself
  produced zero findings.

- 2026-08-05T15:56:24Z, re-verification sweep (task d6f48ad9): 5 stale docs
  re-checked against current sources. Substantive: solution-acceptance-verdict-contract
  gained a new bullet for the Mixed-State-Bypass-Guard (task `8f173547`,
  `OW_FINDINGS_PLACEHOLDER_ROW` / `scanFindings` / `isPlaceholderRow` in
  ow-run-completeness.ts) and had every ow-run-completeness.ts line citation
  re-pinned — that file's header docstring and body grew substantially for the
  guard, shifting citations by anywhere from 0 to +97 lines (non-uniform, so each
  was re-derived by function name, not by a constant offset); solution-verdict.ts
  itself was untouched (all its citations still held exactly). grounding-stack-overview
  and claim-gate-vs-review-claim-gate had drifted version numbers (four locked
  packages 0.5.0 → 0.6.0, grounding-mcp 0.6.0 → 0.7.0, review-claim-gate
  0.1.3 → 0.1.5, review-claim-gate's pinned claim-gate/evidence-ledger deps
  0.5.0 → 0.6.0) — all from the lockstep v0.6.0 release train + consumer re-pins (PR #151,
  97dfa51); no behavior change in the version-number edits themselves, though
  the same release's grounding-mcp 0.7.0 carries the OW mixed-state guard. evidence-ledger-session-key-shapes' db.ts line refs shifted +11
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
  ghost `add`-verb example was corrected to the real `ledger fact` verb here
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
